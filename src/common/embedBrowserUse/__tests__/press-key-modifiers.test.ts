import { describe, expect, jest, test } from '@jest/globals';
import vm from 'node:vm';
import { BrowserController } from '../main';
import { modifiersBitmask, resolveKey } from '../cdp/utils';

/**
 * 回归测试（压测发现）：合成按键路径（webview 未聚焦时）在带修饰键的情况下
 * 仍按 keyDesc.text 插入字符 —— Ctrl+A 会往输入框里塞一个 'a'，既没有全选，
 * 又污染了用户数据。修复后：修饰键分支不插入任何字符，Ctrl/Cmd+A 走页面内全选。
 */

function makeInput(value: string) {
    const el: any = {
        tagName: 'INPUT',
        value,
        selectionStart: value.length,
        selectionEnd: value.length,
        selectCalls: 0,
        dispatchEvent: () => true,
        select() {
            el.selectCalls += 1;
            el.selectionStart = 0;
            el.selectionEnd = el.value.length;
        }
    };
    return el;
}

function makeCtrl() {
    const win = {
        isDestroyed: () => false,
        focus: jest.fn(),
        webContents: { executeJavaScript: jest.fn(async () => ({ result: null })) }
    };
    return new BrowserController('t-press-key', win as any, { beforeCallRenderer: [] });
}

function runKeyScript(script: string, el: any) {
    const context: any = {
        document: { activeElement: el, body: el },
        window: {},
        KeyboardEvent: class {
            type: string;
            constructor(type: string) {
                this.type = type;
            }
        },
        InputEvent: class {
            type: string;
            constructor(type: string) {
                this.type = type;
            }
        },
        HTMLInputElement: { prototype: {} },
        HTMLTextAreaElement: { prototype: {} }
    };
    vm.runInNewContext(script, context);
}

describe('pressKey 修饰键不再插入字符（压测发现）', () => {
    test('Ctrl+A 只做页面内全选，不往输入框插入 "a"', () => {
        const ctrl = makeCtrl();
        const script = (ctrl as any)._makeDispatchKeyInDocumentScript(resolveKey('a'), modifiersBitmask(['Control']));
        const input = makeInput('select-me');

        runKeyScript(script, input);

        expect(input.value).toBe('select-me');
        expect(input.selectCalls).toBe(1);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe('select-me'.length);
    });

    test('Ctrl+C 不写入任何字符（合成事件无法触发复制）', () => {
        const ctrl = makeCtrl();
        const script = (ctrl as any)._makeDispatchKeyInDocumentScript(resolveKey('c'), modifiersBitmask(['Control']));
        const input = makeInput('keep-me');

        runKeyScript(script, input);

        expect(input.value).toBe('keep-me');
        expect(input.selectCalls).toBe(0);
    });

    test('无修饰键时仍保留原有字符插入行为', () => {
        const ctrl = makeCtrl();
        const script = (ctrl as any)._makeDispatchKeyInDocumentScript(resolveKey('a'), 0);

        // 无修饰键脚本走 insertText 分支（含原生 value setter 调用）
        expect(script).toContain('insertText');
        expect(script).not.toContain('htmlInputValueSetter');
    });
});
