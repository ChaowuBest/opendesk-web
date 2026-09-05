import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

interface TestTab {
    id: number;
    webview: any;
    wrapEl: HTMLElement | null;
    ready: boolean;
    internalUrl?: string;
}

type TestWidget = HTMLElement & {
    tabs: TestTab[];
    navigateTo: (input: string) => void;
    goHome: () => void;
};

function stubWebview(wv: any): void {
    wv.executeJavaScript = () => Promise.resolve();
    wv.getWebContentsId = () => 101;
    wv.setZoomFactor = () => undefined;
    wv.canGoBack = () => false;
    wv.canGoForward = () => false;
    wv.loadURL = jest.fn();
}

describe('browser entry widget navigation', () => {
    let widget: TestWidget;

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

        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => ({
            showConfirmModal: jest.fn(async () => false)
        }));

        await import('../../../main/applications/browser/renderer/entry.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        widget = document.createElement('browser-entry-widget') as TestWidget;
        document.body.appendChild(widget);
    });

    function activeTab(): TestTab {
        return widget.tabs[0];
    }

    test('navigating after going home creates a fresh webview instead of reusing the detached one', () => {
        const tab = activeTab();
        expect(tab.internalUrl).toBe('opendesk://homepage/');
        expect(tab.webview).toBeNull();

        // 1. 首次地址栏导航：正常创建 webview 并就绪
        widget.navigateTo('https://example.com');
        expect(tab.webview).not.toBeNull();
        stubWebview(tab.webview);
        tab.webview.dispatchEvent(new CustomEvent('dom-ready'));
        expect(tab.ready).toBe(true);

        // 2. 点击主页：回到内部主页页
        const staleWebview = tab.webview;
        widget.goHome();
        expect(tab.internalUrl).toBe('opendesk://homepage/');
        expect(tab.wrapEl!.querySelector('.wb-hp')).not.toBeNull();

        // 3. 再在地址栏输入网址：必须加载新页面，而不是对已脱离 DOM 的 webview 导航
        widget.navigateTo('https://another.example.org');
        expect(tab.wrapEl!.querySelector('.wb-hp')).toBeNull();
        const wvEl = tab.wrapEl!.querySelector('webview');
        expect(wvEl).not.toBeNull();
        expect(wvEl!.getAttribute('src')).toBe('https://another.example.org');
        expect(tab.webview).not.toBe(staleWebview);
        expect(staleWebview.isConnected).toBe(false);
    });

    test('slow navigation shows a loading overlay until loading stops', () => {
        widget.navigateTo('https://example.com');
        const tab = activeTab();
        stubWebview(tab.webview);
        tab.webview.dispatchEvent(new CustomEvent('dom-ready'));

        tab.webview.dispatchEvent(new CustomEvent('did-start-loading'));
        // 延迟显示，避免快速加载时闪烁
        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).toBeNull();

        jest.advanceTimersByTime(400);
        const overlay = tab.wrapEl!.querySelector('.wb-loading-overlay');
        expect(overlay).not.toBeNull();
        expect(overlay!.querySelector('content-loading-view')).not.toBeNull();

        tab.webview.dispatchEvent(new CustomEvent('did-stop-loading'));
        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).toBeNull();
    });

    test('fast navigation does not flash the loading overlay', () => {
        widget.navigateTo('https://example.com');
        const tab = activeTab();
        stubWebview(tab.webview);
        tab.webview.dispatchEvent(new CustomEvent('dom-ready'));

        tab.webview.dispatchEvent(new CustomEvent('did-start-loading'));
        tab.webview.dispatchEvent(new CustomEvent('did-stop-loading'));
        jest.advanceTimersByTime(400);

        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).toBeNull();
    });

    test('going home drops any pending loading overlay work with the destroyed webview', () => {
        widget.navigateTo('https://example.com');
        const tab = activeTab();
        stubWebview(tab.webview);
        tab.webview.dispatchEvent(new CustomEvent('dom-ready'));

        tab.webview.dispatchEvent(new CustomEvent('did-start-loading'));
        widget.goHome();
        jest.advanceTimersByTime(400);

        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).toBeNull();
        expect(tab.wrapEl!.querySelector('.wb-hp')).not.toBeNull();
    });

    test('overlay clears as soon as navigation commits even while the page keeps loading', () => {
        widget.navigateTo('https://example.com');
        const tab = activeTab();
        stubWebview(tab.webview);
        tab.webview.dispatchEvent(new CustomEvent('dom-ready'));

        // 慢服务器：commit 之前 loading 已持续超过延迟阈值，遮罩出现
        tab.webview.dispatchEvent(new CustomEvent('did-start-loading'));
        jest.advanceTimersByTime(400);
        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).not.toBeNull();

        // 页面 commit（did-navigate）：内容已开始渲染，遮罩必须立即消失
        const navEvent = new window.Event('did-navigate');
        (navEvent as any).url = 'https://example.com/';
        tab.webview.dispatchEvent(navEvent);
        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).toBeNull();

        // commit 后资源仍在加载（尚未 did-stop-loading），遮罩不应再次出现
        jest.advanceTimersByTime(2000);
        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).toBeNull();
    });

    test('in-page navigation clears the overlay without waiting for load completion', () => {
        widget.navigateTo('https://example.com');
        const tab = activeTab();
        stubWebview(tab.webview);
        tab.webview.dispatchEvent(new CustomEvent('dom-ready'));

        tab.webview.dispatchEvent(new CustomEvent('did-start-loading'));
        jest.advanceTimersByTime(400);
        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).not.toBeNull();

        const inPageEvent = new window.Event('did-navigate-in-page');
        (inPageEvent as any).url = 'https://example.com/#section';
        tab.webview.dispatchEvent(inPageEvent);
        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).toBeNull();
    });

    test('failed main-frame load clears the overlay', () => {
        widget.navigateTo('https://example.com');
        const tab = activeTab();
        stubWebview(tab.webview);
        tab.webview.dispatchEvent(new CustomEvent('dom-ready'));

        tab.webview.dispatchEvent(new CustomEvent('did-start-loading'));
        jest.advanceTimersByTime(400);
        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).not.toBeNull();

        const failEvent = new window.Event('did-fail-load');
        (failEvent as any).errorCode = -105;
        (failEvent as any).errorDescription = 'ERR_NAME_NOT_RESOLVED';
        (failEvent as any).validatedURL = 'https://example.com/';
        (failEvent as any).isMainFrame = true;
        tab.webview.dispatchEvent(failEvent);
        expect(tab.wrapEl!.querySelector('.wb-loading-overlay')).toBeNull();
    });
});
