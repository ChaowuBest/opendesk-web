import { describe, expect, test } from '@jest/globals';
import vm from 'node:vm';
import { OD_VISIBLE_TEXT_HELPER } from '../cdp/refQueryScript';

/**
 * 回归测试（压测发现）：`el.innerText || el.textContent` 在"容器里只有
 * <style>/<script> 子节点"时会把整段 CSS/JS 当成可见文本。
 *
 * 真实站点上的表现：Bing 结果页的 listitem 名称是一长串 `.b_rs .b_vList{…}`，
 * click 返回的 text / hitElement.text 同理，waitFor 还可能把 CSS 片段判成
 * "文本已出现"。这里用最小 DOM 桩验证 helper 的回退分支。
 */

type StubEl = any;

/** 在 root 的子树里按标签名（逗号分隔）收集命中元素 */
function queryAll(root: StubEl, selector: string): StubEl[] {
    const tags = selector.split(',').map((s) => s.trim().toUpperCase());
    const hits: StubEl[] = [];
    const walk = (current: StubEl) => {
        for (const child of current.children) {
            if (tags.includes(child.tagName)) hits.push(child);
            walk(child);
        }
    };
    walk(root);
    return hits;
}

function removeFrom(parent: StubEl, child: StubEl): void {
    const index = parent.children.indexOf(child);
    if (index >= 0) parent.children.splice(index, 1);
    child.parentNode = null;
}

function defineShape(node: StubEl): void {
    Object.defineProperty(node, 'textContent', {
        get() {
            return node.text + node.children.map((c: StubEl) => c.textContent).join('');
        }
    });
}

function el(tagName: string, options: { innerText?: string; text?: string; children?: StubEl[] } = {}): StubEl {
    const node: StubEl = {
        tagName: tagName.toUpperCase(),
        children: options.children ?? [],
        innerText: options.innerText ?? '',
        text: options.text ?? '',
        parentNode: null
    };
    for (const child of node.children) child.parentNode = node;
    defineShape(node);
    node.querySelectorAll = (selector: string) => queryAll(node, selector);
    node.removeChild = (child: StubEl) => removeFrom(node, child);
    node.cloneNode = (deep: boolean) => {
        const copy: StubEl = {
            tagName: node.tagName,
            children: deep ? node.children.map((c: StubEl) => c.cloneNode(true)) : [],
            innerText: node.innerText,
            text: node.text,
            parentNode: null
        };
        for (const child of copy.children) child.parentNode = copy;
        defineShape(copy);
        // 克隆体上的 querySelectorAll/removeChild 必须作用于克隆树自身
        copy.querySelectorAll = (selector: string) => queryAll(copy, selector);
        copy.removeChild = (child: StubEl) => removeFrom(copy, child);
        copy.cloneNode = node.cloneNode;
        return copy;
    };
    return node;
}

function loadHelper(): (element: StubEl) => string {
    const context: any = {};
    vm.runInNewContext(OD_VISIBLE_TEXT_HELPER, context);
    return context.__odVisibleText;
}

describe('__odVisibleText：剔除不可见文本', () => {
    const visibleText = loadHelper();

    test('只有 <style> 子节点时返回空串，而不是 CSS 文本', () => {
        const node = el('div', { children: [el('style', { text: '.b_rs .b_vList{font-size:13px}' })] });
        expect(visibleText(node)).toBe('');
    });

    test('<style> + <script> + 可见文本：只保留可见文本', () => {
        const node = el('div', {
            children: [
                el('style', { text: '.a{color:red}' }),
                el('script', { text: 'var a=1;' }),
                el('span', { text: '正常文本' })
            ]
        });
        expect(visibleText(node)).toBe('正常文本');
    });

    test('innerText 有值时优先使用（保留可见性语义）', () => {
        const node = el('div', {
            innerText: '渲染后的文本',
            children: [el('style', { text: '.a{color:red}' })]
        });
        expect(visibleText(node)).toBe('渲染后的文本');
    });

    test('仅空白 innerText 仍会回退，但剔除不可见标签', () => {
        const node = el('div', {
            innerText: '   \n  ',
            children: [el('style', { text: '.a{color:red}' }), el('span', { text: 'B' })]
        });
        expect(visibleText(node)).toBe('B');
    });

    test('嵌套的 style/script 也会被剔除', () => {
        const node = el('ul', {
            children: [el('li', { children: [el('style', { text: '.x{}' }), el('span', { text: 'item' })] })]
        });
        expect(visibleText(node)).toBe('item');
    });
});
