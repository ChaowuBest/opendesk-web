import { describe, expect, jest, test } from '@jest/globals';
import vm from 'node:vm';
import { BrowserController, type BrowserScriptGenerators } from '../main';

/**
 * 回归测试：selectOption 全部未命中时不得改动页面。
 *
 * 背景（压测发现）：原实现先把所有 option 的 selected 置为 false，再读回
 * actual。单选 <select> 不允许"没有任何选中项"，浏览器会立刻回落到第一项，
 * 于是 actual 永远非空 —— "一个都没选上就报错"的分支形同虚设，页面被静默
 * 改成用户没要求的选项，agent 只收到一句部分未命中的 warning。
 *
 * 这里用 vm 真跑 controller 生成的注入脚本，并用手写 select 桩模拟浏览器的
 * 单选回落语义，确保"未命中 → 抛错 + 页面零改动"。
 */

const mockScriptGen: BrowserScriptGenerators = { beforeCallRenderer: [] };

type OptionState = { value: string; selected: boolean };

/** 模拟 HTMLSelectElement：单选时始终至少有一项被选中（浏览器同上语义）。 */
function createSelect(values: string[], opts: { multiple?: boolean; selectedIndex?: number } = {}) {
    const state: OptionState[] = values.map((value, index) => ({
        value,
        selected: index === (opts.selectedIndex ?? 0)
    }));
    const events: string[] = [];
    let muting = false;

    const applySelected = (index: number, next: boolean): void => {
        if (muting) {
            state[index].selected = next;
            return;
        }
        muting = true;
        if (next && !opts.multiple) {
            for (let i = 0; i < state.length; i += 1) state[i].selected = i === index;
        } else {
            state[index].selected = next;
        }
        if (!opts.multiple && state.length > 0 && !state.some((o) => o.selected)) {
            // 单选 select 的浏览器行为：清空后立刻回落到第一项
            state[0].selected = true;
        }
        muting = false;
    };

    const el = {
        tagName: 'SELECT',
        multiple: Boolean(opts.multiple),
        options: state.map((_option, index) => ({
            get value() {
                return state[index].value;
            },
            get selected() {
                return state[index].selected;
            },
            set selected(next: boolean) {
                applySelected(index, next);
            }
        })),
        dispatchEvent(event: { type: string }) {
            events.push(event.type);
            return true;
        }
    };
    return { el, state, events };
}

function makeSession(sendImpl: (method: string, params: any) => Promise<any>) {
    return {
        webContentsId: 5,
        webContents: { focus: jest.fn(), isDestroyed: () => false, isLoading: () => false },
        isHealthy: jest.fn(async () => true),
        waitForPageReady: jest.fn(async () => {}),
        waitForDOMStable: jest.fn(async () => {}),
        ensureDialogHandling: jest.fn(async () => {}),
        takeLastDialog: jest.fn(() => null),
        send: jest.fn(sendImpl)
    } as any;
}

function makeCtrl(session: any) {
    const win = {
        isDestroyed: () => false,
        focus: jest.fn(),
        webContents: { executeJavaScript: jest.fn(async () => ({ result: null })) }
    };
    const ctrl = new BrowserController('t-select-strict', win as any, mockScriptGen);
    (ctrl as any).requireCDP = jest.fn(async () => session);
    (ctrl as any).getCDPSession = jest.fn(async () => session);
    return ctrl;
}

class StubEvent {
    type: string;
    constructor(type: string) {
        this.type = type;
    }
}

/** 把 Runtime.evaluate 收到的表达式在 vm 里真跑一遍，读到的是脚本真实返回值。 */
function makeRunner(select: ReturnType<typeof createSelect>) {
    return makeSession(async (_method: string, params: any) => {
        const expression: string = params?.expression || '';
        const context = {
            document: {
                querySelector: (sel: string) => (sel.includes('data-od-ref') ? select.el : null),
                querySelectorAll: () => []
            },
            Event: StubEvent
        };
        const value = vm.runInNewContext(expression, context);
        return { result: { value } };
    });
}

describe('selectOption 全未命中不修改页面（BUG-19 补充）', () => {
    test('单选 select 传不存在的 value：抛错且页面保持原选中项', async () => {
        const select = createSelect(['a', 'b', 'c'], { selectedIndex: 1 });
        const ctrl = makeCtrl(makeRunner(select));

        await expect(ctrl.selectOption('e13', ['z'])).rejects.toThrow(
            /选项未命中[\s\S]*页面未做任何修改[\s\S]*a, b, c/
        );

        expect(select.state.map((o) => o.selected)).toEqual([false, true, false]);
        expect(select.events).toEqual([]);
    });

    test('多选 select 全未命中同样抛错且不改动', async () => {
        const select = createSelect(['a', 'b'], { multiple: true, selectedIndex: 0 });
        const ctrl = makeCtrl(makeRunner(select));

        await expect(ctrl.selectOption('e13', ['ghost'])).rejects.toThrow('页面未做任何修改');
        expect(select.state.map((o) => o.selected)).toEqual([true, false]);
    });

    test('部分命中：选中命中的值，未命中的值进 warning', async () => {
        const select = createSelect(['a', 'b', 'c']);
        const ctrl = makeCtrl(makeRunner(select));

        const result = await ctrl.selectOption('e13', ['c', 'z']);
        expect(result.selected).toEqual(['c']);
        expect(result.warning).toContain('z');
        expect(select.state.map((o) => o.selected)).toEqual([false, false, true]);
        expect(select.events).toEqual(['input', 'change']);
    });

    test('全部命中：返回真实选中值', async () => {
        const select = createSelect(['a', 'b', 'c']);
        const ctrl = makeCtrl(makeRunner(select));

        const result = await ctrl.selectOption('e13', ['b']);
        expect(result).toEqual({ selected: ['b'] });
        expect(select.state.map((o) => o.selected)).toEqual([false, true, false]);
    });

    test('多选 select 可以一次选中多个', async () => {
        const select = createSelect(['a', 'b', 'c'], { multiple: true });
        const ctrl = makeCtrl(makeRunner(select));

        const result = await ctrl.selectOption('e13', ['a', 'c']);
        expect(result).toEqual({ selected: ['a', 'c'] });
        expect(select.state.map((o) => o.selected)).toEqual([true, false, true]);
    });
});
