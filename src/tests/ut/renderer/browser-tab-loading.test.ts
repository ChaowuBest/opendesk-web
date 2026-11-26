import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { notifyRendererSettingChanged } from '../../../renderer/locale.js';

describe('embedded browser (task-level tab) loading feedback', () => {
    let EmbeddedBrowser: any;

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

        // 固定语言环境，保证 translator 输出稳定的 zh-CN 文案
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        ({ EmbeddedBrowser } = await import('../../../renderer/browser.js'));
    });

    function createBrowser(): any {
        document.body.innerHTML = '';
        const container = document.createElement('div');
        document.body.appendChild(container);
        return new EmbeddedBrowser(container, 'task-1');
    }

    function stubWebview(wv: any): void {
        wv.executeJavaScript = () => Promise.resolve();
        wv.loadURL = jest.fn();
    }

    /** 主框架真实导航（跳转/刷新）：遮罩的唯一触发来源 */
    function mainFrameNav(): Event {
        const event = new window.Event('did-start-navigation');
        (event as any).isMainFrame = true;
        (event as any).isInPlace = false;
        return event;
    }

    /** 子框架导航（iframe 加载）：不应触发遮罩 */
    function subFrameNav(): Event {
        const event = new window.Event('did-start-navigation');
        (event as any).isMainFrame = false;
        (event as any).isInPlace = false;
        return event;
    }

    /** 同文档导航（pushState/hash）：不应触发遮罩 */
    function inPlaceNav(): Event {
        const event = new window.Event('did-start-navigation');
        (event as any).isMainFrame = true;
        (event as any).isInPlace = true;
        return event;
    }

    test('slow navigation shows a loading overlay until loading stops', () => {
        const browser = createBrowser();
        const tab = browser.tabs[0];
        stubWebview(tab.webview);

        tab.webview.dispatchEvent(mainFrameNav());
        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).toBeNull();

        jest.advanceTimersByTime(400);
        const overlay = tab.wrapEl.querySelector('.bw-loading-overlay');
        expect(overlay).not.toBeNull();
        const loadingEl = overlay.querySelector('content-loading-view');
        expect(loadingEl).not.toBeNull();
        expect(loadingEl.getAttribute('data-message')).toBe('正在加载页面...');

        tab.webview.dispatchEvent(new CustomEvent('did-stop-loading'));
        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).toBeNull();
    });

    test('fast navigation does not flash the loading overlay', () => {
        const browser = createBrowser();
        const tab = browser.tabs[0];
        stubWebview(tab.webview);

        tab.webview.dispatchEvent(mainFrameNav());
        tab.webview.dispatchEvent(new CustomEvent('did-stop-loading'));
        jest.advanceTimersByTime(400);

        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).toBeNull();
    });

    test('destroy clears any pending loading overlay timer', () => {
        const browser = createBrowser();
        const tab = browser.tabs[0];
        stubWebview(tab.webview);

        tab.webview.dispatchEvent(mainFrameNav());
        browser.destroy();
        jest.advanceTimersByTime(400);

        expect(document.querySelector('.bw-loading-overlay')).toBeNull();
    });

    test('overlay clears as soon as navigation commits even while the page keeps loading', () => {
        const browser = createBrowser();
        const tab = browser.tabs[0];
        stubWebview(tab.webview);

        tab.webview.dispatchEvent(mainFrameNav());
        jest.advanceTimersByTime(400);
        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).not.toBeNull();

        // 页面 commit：内容已开始渲染，遮罩必须立即消失
        const navEvent = new window.Event('did-navigate');
        (navEvent as any).url = 'https://example.com/';
        tab.webview.dispatchEvent(navEvent);
        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).toBeNull();

        // commit 后资源仍在加载，遮罩不应再次出现
        jest.advanceTimersByTime(2000);
        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).toBeNull();
    });

    test('failed main-frame load clears the overlay', () => {
        const browser = createBrowser();
        const tab = browser.tabs[0];
        stubWebview(tab.webview);

        tab.webview.dispatchEvent(mainFrameNav());
        jest.advanceTimersByTime(400);
        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).not.toBeNull();

        const failEvent = new window.Event('did-fail-load');
        (failEvent as any).errorCode = -105;
        (failEvent as any).errorDescription = 'ERR_NAME_NOT_RESOLVED';
        (failEvent as any).validatedURL = 'https://example.com/';
        (failEvent as any).isMainFrame = true;
        tab.webview.dispatchEvent(failEvent);
        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).toBeNull();
    });

    test('uses the application language for both the certificate warning and tab title', () => {
        notifyRendererSettingChanged({ locale: 'en-US' });
        try {
            const { webview, wrapEl } = createBrowser().tabs[0];
            stubWebview(webview);
            webview.dispatchEvent(
                Object.assign(new window.Event('did-fail-load'), {
                    errorCode: -202,
                    errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
                    validatedURL: 'https://127.0.0.1:8443/',
                    isMainFrame: true
                })
            );
            webview.dispatchEvent(Object.assign(new window.Event('page-title-updated'), { title: 'Chromium' }));

            const title = 'This site’s identity could not be verified';
            expect(wrapEl.querySelector('.od-browser-cert-warning h1')?.textContent).toBe(title);
            expect(document.querySelector('.bw-tab-active .bw-tab-title')?.textContent).toBe(title);
        } finally {
            notifyRendererSettingChanged({ locale: 'zh-CN' });
        }
    });

    test('subframe navigation does not flash the loading overlay', () => {
        const browser = createBrowser();
        const tab = browser.tabs[0];
        stubWebview(tab.webview);

        // 已加载完的页面上 iframe 轮换刷新不应让遮罩反复闪现
        tab.webview.dispatchEvent(subFrameNav());
        jest.advanceTimersByTime(400);
        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).toBeNull();
    });

    test('same-document navigation does not trigger the loading overlay', () => {
        const browser = createBrowser();
        const tab = browser.tabs[0];
        stubWebview(tab.webview);

        tab.webview.dispatchEvent(inPlaceNav());
        jest.advanceTimersByTime(400);
        expect(tab.wrapEl.querySelector('.bw-loading-overlay')).toBeNull();
    });
});
