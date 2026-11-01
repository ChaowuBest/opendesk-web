import { afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 应用启动占位（content-loading-view）的渲染契约：
 * - 宿主可能在元素插入之后才补上/切换本地化文案与布局（独立应用窗口就是这样），
 *   所以组件必须在属性变化时重绘；
 * - 文案是宿主注入的文本，必须按文本转义，不能被当成 HTML 注入。
 */
describe('content-loading-view', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            customElements: window.customElements
        });
        await import('../../../renderer/components/loading.js');
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    function createView(): HTMLElement {
        return document.createElement('content-loading-view');
    }

    test('插入即渲染波浪条与应用启动文案', () => {
        const el = createView();
        el.setAttribute('data-type', 'tb');
        el.setAttribute('data-message', '正在加载应用…');
        document.body.appendChild(el);

        expect(el.querySelectorAll('.od-clv-bar')).toHaveLength(10);
        expect(el.querySelector('.od-clv-wrap')?.className).toContain('od-clv-tb');
        expect(el.querySelector('.od-clv-msg')?.textContent).toBe('正在加载应用…');
    });

    test('插入后再补文案会重绘（宿主晚到的本地化）', () => {
        const el = createView();
        document.body.appendChild(el);
        expect(el.querySelector('.od-clv-msg')).toBeNull();

        el.setAttribute('data-message', 'Loading application…');

        expect(el.querySelector('.od-clv-msg')?.textContent).toBe('Loading application…');
    });

    test('data-type 后设置也能切换布局', () => {
        const el = createView();
        document.body.appendChild(el);
        expect(el.querySelector('.od-clv-wrap')?.className).toContain('od-clv-tb');

        el.setAttribute('data-type', 'lr');

        expect(el.querySelector('.od-clv-wrap')?.className).toContain('od-clv-lr');
    });

    test('文案按文本转义，不会被当成 HTML 注入', () => {
        const el = createView();
        document.body.appendChild(el);

        el.setAttribute('data-message', '<img src=x onerror="alert(1)">');

        const msg = el.querySelector('.od-clv-msg');
        expect(msg?.querySelector('img')).toBeNull();
        expect(msg?.textContent).toBe('<img src=x onerror="alert(1)">');
    });
});
