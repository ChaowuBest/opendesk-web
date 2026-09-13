import { beforeAll, describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 画中画视口模式：
 * - 默认（自适应）模式：webview 虚拟视口宽度固定 1280，高度随容器比例变化，
 *   侧边栏窄高时视口会被拉长（截图窄长）。
 * - 固定模式（画中画显示时）：视口锁定为 16:9（1280x720），截图不再被拉长。
 */
describe('embedded browser pip viewport mode', () => {
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

    /** 模拟侧边栏窄高容器（如 440x900）的 clientWidth/clientHeight */
    function mockContainerSize(browser: any, width: number, height: number): void {
        Object.defineProperty(browser.webviewContainer, 'clientWidth', {
            value: width,
            configurable: true
        });
        Object.defineProperty(browser.webviewContainer, 'clientHeight', {
            value: height,
            configurable: true
        });
    }

    test('default (adaptive) viewport height follows the container aspect ratio', () => {
        const browser = createBrowser();
        mockContainerSize(browser, 440, 900);

        (browser as any)._applyViewportScaling(440, 900);

        const wrap = browser.tabs[0].wrapEl as HTMLElement;
        // 1280 虚拟宽度下，高度 = 900 / (440 / 1280) = 2618.18...（窄长视口）
        expect(parseFloat(wrap.style.height)).toBeCloseTo(2618.18, 1);
    });

    test('fixed viewport (pip) locks the height to 16:9 (720px)', () => {
        const browser = createBrowser();
        mockContainerSize(browser, 440, 900);

        browser.setViewportFixed(true);

        const wrap = browser.tabs[0].wrapEl as HTMLElement;
        expect(wrap.style.height).toBe('720px');
        // 宽度缩放不变：440 / 1280
        expect(wrap.style.transform).toBe('scale(0.34375)');
    });

    test('restoring the viewport re-applies the adaptive height', () => {
        const browser = createBrowser();
        mockContainerSize(browser, 440, 900);

        browser.setViewportFixed(true);
        browser.setViewportFixed(false);

        const wrap = browser.tabs[0].wrapEl as HTMLElement;
        expect(parseFloat(wrap.style.height)).toBeCloseTo(2618.18, 1);
    });
});
