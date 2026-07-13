import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { EmbeddedBrowser } from '../../../renderer/browser.js';

interface FakeElement {
    display: string;
    isConnected: boolean;
    parentElement: FakeElement | null;
    style: Record<string, string>;
    getRootNode: () => Record<string, never>;
    getBoundingClientRect: () => { width: number; height: number };
    querySelectorAll: () => FakeElement[];
}

function makeElement(parentElement: FakeElement | null, size: () => { width: number; height: number }): FakeElement {
    return {
        display: '',
        isConnected: true,
        parentElement,
        style: {},
        getRootNode: () => ({}),
        getBoundingClientRect: size,
        querySelectorAll: () => []
    };
}

function makeBrowserFixture(size: () => { width: number; height: number }, guestReady = true) {
    const html = makeElement(null, size);
    const body = makeElement(html, size);
    const taskView = makeElement(body, size);
    const panel = makeElement(taskView, size);
    const webviewContainer = makeElement(panel, size);
    const wrap = makeElement(webviewContainer, size);
    const webview = makeElement(wrap, size) as FakeElement & {
        executeJavaScript: jest.Mock;
    };
    webview.executeJavaScript = jest.fn(async () => {
        const current = size();
        return {
            innerWidth: current.width,
            innerHeight: current.height,
            documentWidth: current.width,
            documentHeight: current.height
        };
    });
    webviewContainer.querySelectorAll = () => [wrap];

    const browser = Object.create(EmbeddedBrowser.prototype) as any;
    browser.container = panel;
    browser.webviewContainer = webviewContainer;
    browser.tabs = [
        {
            id: 1,
            title: 'New Tab',
            url: 'about:blank',
            webview,
            wrapEl: wrap,
            ready: guestReady,
            pendingUrl: null
        }
    ];
    browser.activeTabId = 1;

    return { browser, taskView, webview };
}

describe('browser navigation readiness', () => {
    const originalWindow = (globalThis as any).window;

    afterEach(() => {
        (globalThis as any).window = originalWindow;
        jest.restoreAllMocks();
    });

    test('waits for two stable non-zero frames before accepting the host viewport', async () => {
        let frame = 0;
        const size = () => (frame < 3 ? { width: 0, height: 0 } : { width: 1280, height: 800 });
        const { browser, webview } = makeBrowserFixture(size);
        (globalThis as any).window = {
            getComputedStyle: (element: FakeElement) => ({ display: element.display }),
            requestAnimationFrame: (callback: () => void) => {
                frame += 1;
                queueMicrotask(callback);
            },
            setTimeout
        };

        await browser.waitUntilReadyForNavigation(1000);

        expect(frame).toBeGreaterThanOrEqual(5);
        expect(webview.executeJavaScript).not.toHaveBeenCalled();
    });

    test('accepts a stable host viewport while a cold about-blank guest is still attaching', async () => {
        let frame = 0;
        const size = () => ({ width: 1280, height: 800 });
        const { browser, webview } = makeBrowserFixture(size, false);
        (globalThis as any).window = {
            getComputedStyle: (element: FakeElement) => ({ display: element.display }),
            requestAnimationFrame: (callback: () => void) => {
                frame += 1;
                queueMicrotask(callback);
            },
            setTimeout
        };

        await browser.waitUntilReadyForNavigation(1000);
        browser.navigateTo('https://example.com');

        expect(frame).toBeGreaterThanOrEqual(2);
        expect(webview.executeJavaScript).not.toHaveBeenCalled();
        expect(browser.tabs[0].pendingUrl).toBe('https://example.com');
        expect(browser.hasActiveContent()).toBe(true);

        // Initial about:blank may report did-navigate after navigateTo() queued
        // the target. The queued URL must keep the browser panel active.
        browser.tabs[0].url = 'about:blank';
        expect(browser.hasActiveContent()).toBe(true);
    });

    test('does not accept a webview below a display-none composed ancestor', async () => {
        let now = 0;
        const size = () => ({ width: 1280, height: 800 });
        const { browser, taskView, webview } = makeBrowserFixture(size);
        taskView.display = 'none';
        jest.spyOn(Date, 'now').mockImplementation(() => {
            now += 5;
            return now;
        });
        (globalThis as any).window = {
            getComputedStyle: (element: FakeElement) => ({ display: element.display }),
            requestAnimationFrame: (callback: () => void) => queueMicrotask(callback),
            setTimeout
        };

        await expect(browser.waitUntilReadyForNavigation(20)).rejects.toThrow('BROWSER_VIEWPORT_NOT_READY');
        expect(webview.executeJavaScript).not.toHaveBeenCalled();
    });
});
