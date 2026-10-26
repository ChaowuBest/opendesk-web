import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { escapeHtml } from '../../../common/utils/escape.js';

const info = jest.fn<any>();
jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () => ({
    showConfirmModal: jest.fn(),
    showInfoModal: info,
    // 真实实现是 escapeHtml + 换行转 <br>：这里复用同一个 escapeHtml，
    // 断言的是调用点有没有走转义，而不是再实现一遍转义规则。
    escapeModalText: (text: string) => escapeHtml(text)
}));

let EmbeddedBrowser: any;
let exportSnapshot: jest.Mock<any>;

beforeAll(async () => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        customElements: window.customElements,
        localStorage: { getItem: () => null }
    });
    // 与真实 translator 一致：支持 ${param} 插值写法（这里退化成 key+params 便于断言）
    (window as any).__odT = (key: string, params?: Record<string, string>) =>
        params ? `${key} ${JSON.stringify(params)}` : key;
    ({ EmbeddedBrowser } = await import('../../../renderer/browser.js'));
});

function makeBrowser(target: any): any {
    const browser = Object.create(EmbeddedBrowser.prototype);
    browser.getActiveTab = () => ({ ready: true, webview: { getWebContentsId: () => target.webContentsId } });
    return browser;
}

beforeEach(() => {
    info.mockReset().mockResolvedValue(undefined);
    exportSnapshot = jest.fn<any>();
    (globalThis as any).window.browserAPI = { exportSnapshot };
});

describe('task browser snapshot export feedback', () => {
    it('reports an export failure instead of swallowing it', async () => {
        exportSnapshot.mockRejectedValue(new Error('Failed to attach CDP debugger: another debugger is attached'));

        await makeBrowser({ webContentsId: 42 }).captureAndSaveSnapshot();

        expect(info).toHaveBeenCalledTimes(1);
        const options = info.mock.calls[0][0];
        expect(options.title).toBe('renderer.browser.snapshot.exportFailed.title');
        expect(options.message).toContain('renderer.browser.snapshot.exportFailed.message');
        // 具体错误文本要带给用户（attach 失败 / 写盘失败 / CDP 超时等各不相同）
        expect(options.message).toContain('another debugger is attached');
    });

    it('escapes the error text before it reaches the modal HTML', async () => {
        // 弹窗 message 按 HTML 渲染，而错误正文可能来自页面（CDP / 页面脚本
        // 抛出的文本，或用户选择的目标路径）：不转义就是一次 HTML 注入。
        exportSnapshot.mockRejectedValue(new Error('<img src=x onerror=alert(1)>'));

        await makeBrowser({ webContentsId: 42 }).captureAndSaveSnapshot();

        const options = info.mock.calls[0][0];
        expect(options.message).not.toContain('<img');
        expect(options.message).toContain('&lt;img');
    });

    it('stays silent when the user cancels the save dialog', async () => {
        exportSnapshot.mockResolvedValue({ canceled: true, filePath: null });

        await makeBrowser({ webContentsId: 42 }).captureAndSaveSnapshot();

        expect(exportSnapshot).toHaveBeenCalledWith(42);
        expect(info).not.toHaveBeenCalled();
    });

    it('reports success once the snapshot has been written', async () => {
        exportSnapshot.mockResolvedValue({ canceled: false, filePath: '/tmp/snapshot.txt' });

        await makeBrowser({ webContentsId: 42 }).captureAndSaveSnapshot();

        expect(info).toHaveBeenCalledTimes(1);
        const options = info.mock.calls[0][0];
        expect(options.title).toBe('renderer.browser.snapshot.exportSaved.title');
        expect(options.message).toBe('renderer.browser.snapshot.exportSaved.message');
        expect(options.variant).toBe('success');
    });

    it('reports an unsupported environment instead of doing nothing', async () => {
        (globalThis as any).window.browserAPI = {};

        await makeBrowser({ webContentsId: 42 }).captureAndSaveSnapshot();

        expect(exportSnapshot).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0][0].message).toBe('renderer.browser.snapshot.exportUnsupported');
    });

    it('does nothing when there is no ready tab', async () => {
        const browser = Object.create(EmbeddedBrowser.prototype);
        browser.getActiveTab = () => ({ ready: false, webview: null });

        await browser.captureAndSaveSnapshot();

        expect(exportSnapshot).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });
});
