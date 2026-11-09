import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { SNAPSHOT_INJECTION } from '../cdp/snapshot.js';
import type { FrameAriaResult } from '../cdp/aria.js';

/**
 * 回归测试（BUG-33 配套）：shadow root 内已存在的 data-od-ref 必须计入
 * ref 续号扫描。扫描只查 light DOM 时，会给新元素铸出与 shadow 内已有
 * ref 相同的编号——findNodeByRef/click 解析 ref 时会命中错误的元素。
 */

function capture(markup: string, attachShadow?: (document: Document) => void): FrameAriaResult {
    const { document, window } = parseHTML(`<html><head><title>T</title></head><body>${markup}</body></html>`);
    const elementPrototype = window.HTMLElement.prototype as unknown as {
        getBoundingClientRect: () => { width: number; height: number };
    };
    elementPrototype.getBoundingClientRect = function () {
        const element = this as unknown as Element;
        return {
            width: Number(element.getAttribute('data-width') ?? 10),
            height: Number(element.getAttribute('data-height') ?? 10)
        };
    };
    attachShadow?.(document);

    const result = vm.runInNewContext(SNAPSHOT_INJECTION, {
        document,
        window: { innerWidth: 1280, innerHeight: 720, scrollX: 0, scrollY: 0 },
        location: { href: 'https://example.test/shadow' },
        getComputedStyle: () => ({
            cursor: '',
            display: 'block',
            opacity: '1',
            pointerEvents: 'auto',
            visibility: 'visible'
        }),
        HTMLInputElement: window.HTMLInputElement,
        HTMLTextAreaElement: window.HTMLTextAreaElement
    });
    return JSON.parse(result) as FrameAriaResult;
}

function collectRefs(node: any, out: string[] = []): string[] {
    if (node?.ref) out.push(node.ref);
    for (const child of node?.children ?? []) {
        if (typeof child !== 'string') collectRefs(child, out);
    }
    return out;
}

describe('snapshot shadow ref 续号（BUG-33 配套）', () => {
    test('shadow 内已有的 ref 不会被再次铸给 light DOM 新元素', () => {
        // 9 个已带 ref 的 light 元素（e0..e8）+ shadow 内已有 e9 + 一个待铸号新元素：
        // 续号扫描若漏掉 shadow，refIdx=9 → 新元素被铸出与 shadow 冲突的 e9
        const pre = Array.from(
            { length: 9 },
            (_, i) => `<span data-od-ref="e${i}" data-width="4" data-height="4">p${i}</span>`
        ).join('');
        const snapshot = capture(
            `${pre}<button id="late" data-width="10" data-height="10">late-button</button>`,
            (document) => {
                const host = document.createElement('div');
                host.setAttribute('data-width', '20');
                host.setAttribute('data-height', '20');
                const shadow = (host as any).attachShadow({ mode: 'open' });
                shadow.innerHTML = '<span data-od-ref="e9">shadow-text</span>';
                document.body.prepend(host);
            }
        );

        const refs = collectRefs(snapshot.root);
        // shadow 内已有 ref e9 被保留（capture 复用已有 ref）
        expect(refs.filter((r) => r === 'e9')).toHaveLength(1);
        // 新元素从 e10 起铸号（修复前会铸出重复的 e9）
        expect(refs).toContain('e10');
        expect(new Set(refs).size).toBe(refs.length);
    });

    test('纯 light DOM 页面的续号行为不变（回归保护）', () => {
        const first = capture(`<button id="a" data-width="10" data-height="10">A</button>`);
        const refs = collectRefs(first.root);
        expect(refs).toContain('e0');
    });

    test('嵌套 shadow root 内的 ref 同样计入续号扫描（快照 walk 递归下钻 shadow）', () => {
        // light e0..e8 + 外层 shadow e9 + 内层 shadow e10 + 一个待铸号新元素：
        // 续号扫描只扫一层 shadow 时，内层 shadow 的 e10 被漏掉 → 新元素被铸出
        // 与内层 shadow 冲突的 e10
        const pre = Array.from(
            { length: 9 },
            (_, i) => `<span data-od-ref="e${i}" data-width="4" data-height="4">p${i}</span>`
        ).join('');
        const snapshot = capture(
            `${pre}<button id="late" data-width="10" data-height="10">late-button</button>`,
            (document) => {
                const outerHost = document.createElement('div');
                outerHost.setAttribute('data-width', '20');
                outerHost.setAttribute('data-height', '20');
                const outerShadow = (outerHost as any).attachShadow({ mode: 'open' });
                outerShadow.innerHTML = '<span data-od-ref="e9">outer-text</span>';
                const innerHost = document.createElement('div');
                innerHost.setAttribute('data-width', '20');
                innerHost.setAttribute('data-height', '20');
                const innerShadow = (innerHost as any).attachShadow({ mode: 'open' });
                innerShadow.innerHTML = '<span data-od-ref="e10">inner-text</span>';
                outerShadow.appendChild(innerHost);
                document.body.prepend(outerHost);
            }
        );

        const refs = collectRefs(snapshot.root);
        expect(refs.filter((r) => r === 'e10')).toHaveLength(1);
        // 新元素从 e11 起铸号（只扫一层时会铸出重复的 e10）
        expect(refs).toContain('e11');
        expect(new Set(refs).size).toBe(refs.length);
    });
});
