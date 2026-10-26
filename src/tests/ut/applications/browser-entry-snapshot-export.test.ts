import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { escapeHtml } from '../../../common/utils/escape.js';

const modal = jest.fn<any>();
jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () => ({
    showConfirmModal: modal,
    showInfoModal: jest.fn(),
    // 真实实现是 escapeHtml + 换行转 <br>：这里复用同一个 escapeHtml，
    // 断言的是调用点有没有走转义，而不是再实现一遍转义规则。
    escapeModalText: (text: string) => escapeHtml(text)
}));

/**
 * 浏览器应用（独立窗口）里「导出快照」的提示行为。
 *
 * 弹窗 message 按 HTML 渲染，而错误正文可能来自页面（CDP / 页面脚本抛出的
 * 文本）或用户选择的目标路径，必须整段转义后再插入。
 */
describe('browser application snapshot export feedback', () => {
    let widget: any;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            localStorage: {
                getItem: () => null,
                setItem: () => undefined,
                removeItem: () => undefined
            },
            ResizeObserver: class {
                observe() {}
                disconnect() {}
            },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        (window.Element.prototype as any).scrollIntoView = () => undefined;

        jest.useFakeTimers();

        await import('../../../main/applications/browser/renderer/entry.js');
    });

    beforeEach(() => {
        modal.mockReset().mockResolvedValue(undefined);
        document.body.innerHTML = '';
        widget = document.createElement('browser-entry-widget');
        document.body.appendChild(widget);
    });

    afterEach(() => {
        delete (window as any).applicationRegistryAPI;
    });

    /** 让活跃标签页处于「已就绪」状态：导出流程只关心 webContentsId */
    function prepareReadyTab(): void {
        widget.navigateTo('https://example.com');
        const tab = widget.tabs[0];
        tab.webview.executeJavaScript = () => Promise.resolve();
        tab.webview.getWebContentsId = () => 101;
        tab.webview.setZoomFactor = () => undefined;
        tab.webview.canGoBack = () => false;
        tab.webview.canGoForward = () => false;
        tab.webview.loadURL = jest.fn();
        tab.webview.dispatchEvent(new window.CustomEvent('dom-ready'));
        expect(tab.ready).toBe(true);
    }

    it('escapes the failure reason before it reaches the modal HTML', async () => {
        prepareReadyTab();
        (window as any).applicationRegistryAPI = {
            callMainWorld: jest.fn(async () => {
                throw new Error('<img src=x onerror=alert(1)>');
            })
        };

        await widget.captureAndSaveSnapshot();

        expect(modal).toHaveBeenCalledTimes(1);
        const options = modal.mock.calls[0][0];
        expect(options.message).not.toContain('<img');
        expect(options.message).toContain('&lt;img');
    });

    it('does not report success when the user cancels the save dialog', async () => {
        prepareReadyTab();
        const callMainWorld = jest.fn(async () => ({ canceled: true, filePath: null }));
        (window as any).applicationRegistryAPI = { callMainWorld };

        await widget.captureAndSaveSnapshot();

        expect(callMainWorld).toHaveBeenCalledTimes(1);
        expect(modal).not.toHaveBeenCalled();
    });
});
