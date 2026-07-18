import { jest } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { morphDomChildren } from '../../../renderer/utils/dom-morph.js';

describe('morphDomChildren', () => {
    beforeAll(() => {
        const { window, document, HTMLElement, customElements, Event, CustomEvent } = parseHTML(
            '<!DOCTYPE html><html><body></body></html>'
        );
        Object.assign(globalThis, {
            window,
            document,
            HTMLElement,
            customElements,
            Event,
            CustomEvent,
            Node: window.Node,
            navigator: { language: 'zh-CN', languages: ['zh-CN'] }
        });
    });

    function makeContainer(html) {
        const tpl = document.createElement('template');
        tpl.innerHTML = html.trim();
        const container = document.createElement('div');
        for (const child of [...tpl.content.childNodes]) {
            container.appendChild(child.cloneNode(true));
        }
        return container;
    }

    // ─── 空输入 ──────────────────────────────────────────────────

    test('空字符串清空所有子节点', () => {
        const container = makeContainer('<span>hello</span><span>world</span>');
        morphDomChildren(container, '');
        expect(container.childNodes.length).toBe(0);
    });

    test('空白字符串清空所有子节点', () => {
        const container = makeContainer('<span>hello</span>');
        morphDomChildren(container, '   ');
        expect(container.childNodes.length).toBe(0);
    });

    test('containerEl 为 null 时安全返回', () => {
        expect(() => morphDomChildren(null, '<span>a</span>')).not.toThrow();
    });

    // ─── 文本节点更新 ────────────────────────────────────────────

    test('文本节点内容变化时原地更新', () => {
        const container = makeContainer('<span>old text</span>');
        const originalSpan = container.firstChild;
        morphDomChildren(container, '<span>new text</span>');
        expect(container.firstChild).toBe(originalSpan);
        expect(container.firstChild.textContent).toBe('new text');
    });

    test('文本节点内容未变时不操作', () => {
        const container = makeContainer('<span>same</span>');
        const originalSpan = container.firstChild;
        morphDomChildren(container, '<span>same</span>');
        expect(container.firstChild).toBe(originalSpan);
    });

    // ─── 元素替换 ────────────────────────────────────────────────

    test('标签名不同时替换元素', () => {
        const container = makeContainer('<div>content</div>');
        const oldDiv = container.firstChild;
        morphDomChildren(container, '<span>content</span>');
        expect(container.firstChild).not.toBe(oldDiv);
        expect(container.firstChild.nodeName).toBe('SPAN');
    });

    test('class 列表不同时替换元素', () => {
        const container = makeContainer('<div class="a b">x</div>');
        const oldDiv = container.firstChild;
        morphDomChildren(container, '<div class="a c">x</div>');
        expect(container.firstChild).not.toBe(oldDiv);
    });

    test('class 数量不同时替换元素', () => {
        const container = makeContainer('<div class="a">x</div>');
        const oldDiv = container.firstChild;
        morphDomChildren(container, '<div class="a b">x</div>');
        expect(container.firstChild).not.toBe(oldDiv);
    });

    // ─── 新增 / 删除子节点 ───────────────────────────────────────

    test('新增子节点', () => {
        const container = makeContainer('<span>1</span>');
        morphDomChildren(container, '<span>1</span><span>2</span>');
        expect(container.childNodes.length).toBe(2);
        expect(container.childNodes[1].textContent).toBe('2');
    });

    test('删除多余的子节点', () => {
        const container = makeContainer('<span>1</span><span>2</span><span>3</span>');
        morphDomChildren(container, '<span>1</span>');
        expect(container.childNodes.length).toBe(1);
    });

    // ─── 属性同步 ────────────────────────────────────────────────

    test('新增属性', () => {
        const container = makeContainer('<div>content</div>');
        morphDomChildren(container, '<div data-x="1">content</div>');
        expect(container.firstChild.getAttribute('data-x')).toBe('1');
    });

    test('移除属性', () => {
        const container = makeContainer('<div data-x="1">content</div>');
        morphDomChildren(container, '<div>content</div>');
        expect(container.firstChild.hasAttribute('data-x')).toBe(false);
    });

    test('更新属性值', () => {
        const container = makeContainer('<div data-x="old">content</div>');
        morphDomChildren(container, '<div data-x="new">content</div>');
        expect(container.firstChild.getAttribute('data-x')).toBe('new');
    });

    test('不同 class 时替换元素（不触碰 class 属性 diff）', () => {
        const container = makeContainer('<div class="keep-me">content</div>');
        morphDomChildren(container, '<div class="other">content</div>');
        // class 不同 → 元素被替换
        expect(container.firstChild.nodeName).toBe('DIV');
        expect(container.firstChild.className).toBe('other');
    });

    // ─── 嵌套结构 ────────────────────────────────────────────────

    test('嵌套结构内文本更新保留父容器', () => {
        const container = makeContainer('<div><span>old</span></div>');
        const oldDiv = container.firstChild;
        morphDomChildren(container, '<div><span>new</span></div>');
        expect(container.firstChild).toBe(oldDiv);
        expect(container.firstChild.firstChild.textContent).toBe('new');
    });

    test('嵌套结构新增子元素', () => {
        const container = makeContainer('<div><span>a</span></div>');
        const oldDiv = container.firstChild;
        morphDomChildren(container, '<div><span>a</span><span>b</span></div>');
        expect(container.firstChild).toBe(oldDiv);
        expect(container.firstChild.childNodes.length).toBe(2);
    });

    // ─── 混合节点类型 ────────────────────────────────────────────

    test('文本节点与元素节点混合 - 文本原位更新', () => {
        const container = makeContainer('<div>text <span>element</span></div>');
        const oldDiv = container.firstChild;
        morphDomChildren(container, '<div>updated <span>element</span></div>');
        expect(container.firstChild).toBe(oldDiv);
        expect(container.firstChild.firstChild.textContent).toBe('updated ');
        expect(container.firstChild.childNodes[1].textContent).toBe('element');
    });

    // ─── 高频更新场景 ────────────────────────────────────────────

    test('多次 morph 调用不泄露旧节点引用', () => {
        const container = makeContainer('<div class="tool-result"><span>loading...</span></div>');
        const oldSpan = container.querySelector('span');

        morphDomChildren(container, '<div class="tool-result"><code>partial result</code></div>');
        expect(container.querySelector('code').textContent).toBe('partial result');

        morphDomChildren(container, '<div class="tool-result"><code>final result</code></div>');
        expect(container.querySelector('code').textContent).toBe('final result');
        expect(container.childNodes.length).toBe(1);
    });
});
