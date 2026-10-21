import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { createTouchLongPressController, TOUCH_LONG_PRESS_SCRIPT } from '../../../renderer/touchLongPressScript.js';

/**
 * 触摸长按 → 右键点击（全局）。
 *
 * Chromium 桌面版在触摸屏上没有"长按 = 右键"手势（长按只用于选词），OpenDesk
 * 以主世界注入脚本补偿。行为约定：
 * - 单指按下起 120ms 判定期（期间抬起视为单击，无任何视觉）；之后在触摸点显示
 *   圆环进度动画，计时从显示时从 0 起算（550ms）；
 * - 进度满后保持满环（就绪态），等用户松开手指才触发右键；就绪后移动超容差、
 *   多指、touchcancel 仍会取消；touchcancel 一律取消（手势被接管后收不到
 *   touchend，「松开才触发」无从满足），绝不在手指未松开时弹菜单；
 * - 圆环出现起 html 挂 od-lp-holding 整体禁用文本选择（规避 Chromium 触摸长按
 *   选词手势在 ~500ms 接管触摸），结束/取消时移除；编辑区触发时在触摸点补选词
 *   （caretRangeFromPoint + selection.modify），供自绘菜单的剪切/复制使用；
 * - 手势期间（含拖拽表面宽限期）触摸来源的原生 contextmenu（sourceCapabilities
 *   .firesTouchEvents=true，Chromium 长按派发）一律吞掉；松开时脚本派发的合成
 *   contextmenu 无该标记，是菜单的唯一来源；真实鼠标右键不受影响；
 * - 触发时清除触摸选词产生的选区，并在命中元素上派发合成 contextmenu（局部
 *   坐标，自绘菜单位置天然精确）；
 * - 拖拽/缩放表面（祖先带 data-od-no-longpress：窗口边缘感应条、分栏分割线、
 *   桌面卡片/悬浮窗拖拽条与缩放手柄）按下即跳过长按手势：无圆环、无触发；
 * - 命中编辑区且宿主标记 data-od-lp-edit-menu（OpenDesk 自家 frame）时，弹出
 *   脚本内自绘的剪切/复制/粘贴/全选菜单：位置即触摸点；复制/剪切经桥
 *   CustomEvent('od-clipboard-write') 写剪贴板，粘贴经 CustomEvent
 *   ('od-clipboard-read' / 'od-clipboard-read-result') 异步读剪贴板后插入；
 * - 触发后拦截 Chromium 模拟的 mousedown/mouseup/click 序列一轮，防止误触发。
 */

interface TouchPoint {
    identifier: number;
    clientX: number;
    clientY: number;
}

const SHOW_DELAY_MS = 120;

let win: any;
let doc: any;

function touch(type: string, touches: TouchPoint[], changed: TouchPoint[]): Event {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { touches, changedTouches: changed });
    return event;
}

function press(x: number, y: number, id = 1): Event {
    return touch(
        'touchstart',
        [{ identifier: id, clientX: x, clientY: y }],
        [{ identifier: id, clientX: x, clientY: y }]
    );
}

function move(x: number, y: number, id = 1): Event {
    return touch(
        'touchmove',
        [{ identifier: id, clientX: x, clientY: y }],
        [{ identifier: id, clientX: x, clientY: y }]
    );
}

function lift(x: number, y: number, id = 1): Event {
    return touch('touchend', [], [{ identifier: id, clientX: x, clientY: y }]);
}

function setupDom(): void {
    const parsed = parseHTML('<!doctype html><html><head></head><body></body></html>');
    win = parsed.window;
    doc = parsed.window.document;
    Object.assign(globalThis, { window: win, document: doc });
    // linkedom 多次 parseHTML 的 window 属性互通，须清除跨测试残留
    delete win.__odTouchLongPressInstalled;
    delete win.navigator;
    delete win.getSelection;
    // linkedom 不提供 MouseEvent，补一个携带坐标属性的 stub（controller 经 window 取构造器）
    if (!win.MouseEvent) {
        win.MouseEvent = class extends win.Event {
            constructor(type: string, init: any = {}) {
                super(type, init);
                this.clientX = init.clientX || 0;
                this.clientY = init.clientY || 0;
                this.button = init.button || 0;
                this.buttons = init.buttons || 0;
            }
        };
    }
    if (!win.KeyboardEvent) {
        win.KeyboardEvent = class extends win.Event {
            constructor(type: string, init: any = {}) {
                super(type, init);
                this.key = init.key || '';
                this.ctrlKey = !!init.ctrlKey;
                this.code = init.code || '';
            }
        };
    }
}

function recordedEvents(target: any, type: string): any[] {
    const events: any[] = [];
    target.addEventListener(type, (e: any) => events.push(e));
    return events;
}

beforeEach(() => {
    jest.useFakeTimers();
    setupDom();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('触摸长按右键：手势状态机', () => {
    test('按下 120ms 显示圆环，计时从显示时从 0 起算，满环后抬起才触发', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        const touchActiveEvents = recordedEvents(win, 'od-touch-active');

        doc.dispatchEvent(press(120, 80));

        // 按下瞬间不显示（多数触摸是单击），避免每次点按都闪一个圈
        expect(doc.getElementById('od-longpress-indicator')).toBeNull();
        expect(touchActiveEvents).toHaveLength(0);

        jest.advanceTimersByTime(119);
        expect(doc.getElementById('od-longpress-indicator')).toBeNull();

        jest.advanceTimersByTime(1);
        const indicator = doc.getElementById('od-longpress-indicator');
        expect(indicator).toBeTruthy();
        expect(indicator.classList.contains('visible')).toBe(true);
        // 外层以 transform 定位（触摸点居中，半径 40px），进度动画在内层，互不冲突
        expect(indicator.style.transform).toBe('translate(80px, 40px)');

        // 计时从圆环显示时从 0 起算：550ms 满环时不触发（等待松手）
        jest.advanceTimersByTime(549);
        expect(contextEvents).toHaveLength(0);
        jest.advanceTimersByTime(1);
        expect(contextEvents).toHaveLength(0);
        expect(indicator.classList.contains('fired')).toBe(false);

        // 松开手指才触发
        doc.dispatchEvent(lift(120, 80));
        expect(contextEvents).toHaveLength(1);
        expect(contextEvents[0].clientX).toBe(120);
        expect(contextEvents[0].clientY).toBe(80);
    });

    test('快速点击（判定期内抬起）不显示指示器也不触发', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(50, 50));
        jest.advanceTimersByTime(50);
        doc.dispatchEvent(lift(50, 50));
        jest.advanceTimersByTime(1000);

        expect(doc.getElementById('od-longpress-indicator')).toBeNull();
        expect(contextEvents).toHaveLength(0);
    });

    test('在命中元素上派发 contextmenu（自绘菜单位置精确）', () => {
        createTouchLongPressController();

        const target = doc.createElement('div');
        doc.body.appendChild(target);
        doc.elementFromPoint = () => target;

        const targetContext = recordedEvents(target, 'contextmenu');
        const bubbledContext = recordedEvents(win, 'contextmenu');

        doc.dispatchEvent(press(300, 200));
        jest.advanceTimersByTime(670);
        doc.dispatchEvent(lift(300, 200));

        expect(targetContext).toHaveLength(1);
        expect(bubbledContext).toHaveLength(1);
        expect(bubbledContext[0].button).toBe(2);
        expect(bubbledContext[0].clientX).toBe(300);
        expect(bubbledContext[0].clientY).toBe(200);
    });

    test('移动超出容差（36px）取消长按并淡出移除指示器', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(100, 100));
        jest.advanceTimersByTime(130);
        // 圆环出现即挂 hold 类（禁用文本选择）
        expect(doc.documentElement.classList.contains('od-lp-holding')).toBe(true);
        doc.dispatchEvent(move(150, 100));

        // 取消走快速淡出而非瞬间消失，避免视觉闪烁
        const indicator = doc.getElementById('od-longpress-indicator');
        expect(indicator).toBeTruthy();
        expect(indicator.classList.contains('cancelling')).toBe(true);
        // 取消时解除禁选
        expect(doc.documentElement.classList.contains('od-lp-holding')).toBe(false);

        jest.advanceTimersByTime(1000);
        doc.dispatchEvent(lift(150, 100));
        expect(contextEvents).toHaveLength(0);
        expect(doc.getElementById('od-longpress-indicator')).toBeNull();
    });

    test('进度满后保持满环，移动超容差仍会取消', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(100, 100));
        jest.advanceTimersByTime(670);
        expect(contextEvents).toHaveLength(0);

        doc.dispatchEvent(move(160, 100));
        const indicator = doc.getElementById('od-longpress-indicator');
        expect(indicator).toBeTruthy();
        expect(indicator.classList.contains('cancelling')).toBe(true);

        doc.dispatchEvent(lift(160, 100));
        expect(contextEvents).toHaveLength(0);
    });

    test('容差内的移动不取消长按，指示器跟随手指', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(100, 100));
        doc.dispatchEvent(move(130, 116));

        // 延迟显示前移动：指示器尚未出现，但位置记录已更新
        expect(doc.getElementById('od-longpress-indicator')).toBeNull();

        jest.advanceTimersByTime(120);
        // 显示时出现在最新手指位置（130-40, 116-40）
        const indicator = doc.getElementById('od-longpress-indicator');
        expect(indicator).toBeTruthy();
        expect(indicator.classList.contains('cancelling')).toBe(false);
        expect(indicator.style.transform).toBe('translate(90px, 76px)');

        // 计时从显示时起算，满环后抬起触发
        jest.advanceTimersByTime(549);
        expect(contextEvents).toHaveLength(0);
        jest.advanceTimersByTime(1);
        doc.dispatchEvent(lift(130, 116));
        expect(contextEvents).toHaveLength(1);
    });

    test('触发坐标使用最新手指位置', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(100, 100));
        doc.dispatchEvent(move(120, 110));
        jest.advanceTimersByTime(670);
        doc.dispatchEvent(lift(120, 110));

        expect(contextEvents).toHaveLength(1);
        expect(contextEvents[0].clientX).toBe(120);
        expect(contextEvents[0].clientY).toBe(110);
    });

    test('手势期间吞掉触摸来源的原生 contextmenu（Chromium 长按），不弹菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const textarea = doc.createElement('textarea');
        doc.body.appendChild(textarea);
        doc.elementFromPoint = () => textarea;

        doc.dispatchEvent(press(150, 120));
        jest.advanceTimersByTime(300);

        // Chromium 原生长按派发的真实 contextmenu：带触摸 sourceCapabilities 标记
        const native = dispatchTouchContextMenu(150, 120, textarea);
        expect(native.defaultPrevented).toBe(true);
        expect((native as any).stopPropagationCalls).toBe(1);
        expect(doc.getElementById('od-edit-menu')).toBeNull();
    });

    test('可编辑区满环松开触发：hold 期挂 od-lp-holding，触发时在触摸点补选词', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const textarea = doc.createElement('textarea');
        doc.body.appendChild(textarea);
        doc.elementFromPoint = () => textarea;

        // 选词链路 stub：caretRangeFromPoint 返回命中位置，selection 记录调用
        const selectionCalls: string[] = [];
        Object.defineProperty(win, 'getSelection', {
            value: () => ({
                setBaseAndExtent: () => selectionCalls.push('setBaseAndExtent'),
                modify: () => selectionCalls.push('modify'),
                removeAllRanges: () => {}
            }),
            configurable: true
        });
        (doc as any).caretRangeFromPoint = (x: number, y: number) => ({ startContainer: { x, y }, startOffset: 3 });

        doc.dispatchEvent(press(150, 120));
        jest.advanceTimersByTime(120);
        // 圆环出现即禁用文本选择（规避 Chromium 触摸选词手势接管）
        expect(doc.documentElement.classList.contains('od-lp-holding')).toBe(true);

        jest.advanceTimersByTime(550);
        doc.dispatchEvent(lift(150, 120));

        // 结束后解除禁选；触发时在触摸点补选词（定位后向前后扩到词边界）
        expect(doc.documentElement.classList.contains('od-lp-holding')).toBe(false);
        expect(selectionCalls[0]).toBe('setBaseAndExtent');
        expect(selectionCalls.slice(1)).toEqual(['modify', 'modify']);
        // 合成 contextmenu 弹出自绘编辑菜单
        expect(doc.getElementById('od-edit-menu')).toBeTruthy();
    });

    test('touchcancel（无移动，手势被接管）不触发菜单：只有松开手指才触发', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const textarea = doc.createElement('textarea');
        doc.body.appendChild(textarea);
        doc.elementFromPoint = () => textarea;

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(150, 120));
        jest.advanceTimersByTime(670);
        // Chromium/系统手势接管派发 touchcancel（此后收不到 touchend）
        doc.dispatchEvent(touch('touchcancel', [], [{ identifier: 1, clientX: 150, clientY: 120 }]));

        // 手指未松开不得弹出任何菜单
        expect(contextEvents).toHaveLength(0);
        expect(doc.getElementById('od-edit-menu')).toBeNull();
        // 圆环按取消收尾，不进入触发态；禁选同步解除
        const indicator = doc.getElementById('od-longpress-indicator');
        expect(indicator).toBeTruthy();
        expect(indicator.classList.contains('fired')).toBe(false);
        expect(indicator.classList.contains('cancelling')).toBe(true);
        expect(doc.documentElement.classList.contains('od-lp-holding')).toBe(false);
    });

    test('markdown 预览等只读文本区：满环松开后按既有选区弹出编辑菜单（剪切/粘贴置灰）', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const pre = doc.createElement('pre');
        const code = doc.createElement('span');
        pre.appendChild(code);
        doc.body.appendChild(pre);
        doc.elementFromPoint = () => code;
        Object.defineProperty(win, 'getSelection', {
            value: () => ({ isCollapsed: false, toString: () => 'selected code', selectAllChildren: () => {} }),
            configurable: true
        });

        doc.dispatchEvent(press(300, 400));
        jest.advanceTimersByTime(670);
        doc.dispatchEvent(lift(300, 400));

        const menu = doc.getElementById('od-edit-menu');
        expect(menu).toBeTruthy();
        // 只读选区：剪切/粘贴置灰
        const buttons = Array.from(menu.querySelectorAll('.od-edit-menu-item'));
        expect(buttons[0].classList.contains('disabled')).toBe(true);
        expect(buttons[1].classList.contains('disabled')).toBe(false);
    });

    test('touchcancel（有移动，滚动接管）取消长按并淡出', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const div = doc.createElement('div');
        doc.body.appendChild(div);
        doc.elementFromPoint = () => div;

        doc.dispatchEvent(press(100, 100));
        jest.advanceTimersByTime(130);
        // 小位移（未超取消容差）即构成移动意图 → 滚动接管
        doc.dispatchEvent(move(112, 100));
        doc.dispatchEvent(touch('touchcancel', [], [{ identifier: 1, clientX: 112, clientY: 100 }]));
        const indicator = doc.getElementById('od-longpress-indicator');
        expect(indicator).toBeTruthy();
        expect(indicator.classList.contains('cancelling')).toBe(true);
        jest.advanceTimersByTime(1000);
        expect(doc.getElementById('od-longpress-indicator')).toBeNull();
        expect(doc.getElementById('od-edit-menu')).toBeNull();
    });

    test('拖拽/缩放表面（data-od-no-longpress）：不显示圆环、不挂 hold 类、不触发右键', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const handle = doc.createElement('div');
        handle.setAttribute('data-od-no-longpress', '1');
        doc.body.appendChild(handle);

        const contextEvents = recordedEvents(win, 'contextmenu');
        // 触摸事件派发到标记元素：真实触摸的 target 即命中元素
        handle.dispatchEvent(press(20, 20));
        jest.advanceTimersByTime(700);

        expect(doc.getElementById('od-longpress-indicator')).toBeNull();
        expect(doc.documentElement.classList.contains('od-lp-holding')).toBe(false);
        handle.dispatchEvent(lift(20, 20));
        expect(contextEvents).toHaveLength(0);
    });

    test('标记表面宽限期内吞掉触摸来源的原生 contextmenu，宽限期外恢复放行', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const handle = doc.createElement('div');
        handle.setAttribute('data-od-no-longpress', '1');
        doc.body.appendChild(handle);

        handle.dispatchEvent(press(20, 20));
        jest.advanceTimersByTime(600);
        // 手指仍按在缩放手柄上，Chromium 长按派发原生 contextmenu：吞掉
        const native = dispatchTouchContextMenu(20, 20, handle);
        expect(native.defaultPrevented).toBe(true);

        // 宽限期（1500ms）过后不再吞（此时不可能仍是长按手势）
        jest.advanceTimersByTime(1600);
        const late = dispatchTouchContextMenu(20, 20, handle);
        expect(late.defaultPrevented).toBe(false);
    });

    test('真实 contextmenu（Chromium 原生长按/鼠标右键）在编辑区弹出自绘菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('textarea');
        doc.body.appendChild(input);

        const event = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        Object.assign(event, { clientX: 300, clientY: 220 });
        input.dispatchEvent(event);

        const menu = doc.getElementById('od-edit-menu');
        expect(menu).toBeTruthy();
        expect(menu.style.left).toBe('300px');
        expect(menu.style.top).toBe('220px');
        expect(event.defaultPrevented).toBe(true);
    });

    function dispatchContextMenu(x: number, y: number, target: any): any {
        const event = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        Object.assign(event, { clientX: x, clientY: y });
        target.dispatchEvent(event);
        return event;
    }

    // 带触摸 sourceCapabilities 标记的原生 contextmenu（Chromium 触摸长按派发），
    // 并记录 stopPropagation 调用次数（linkedom 无法从外部断言冒泡阻断）
    function dispatchTouchContextMenu(x: number, y: number, target: any): any {
        const event = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        Object.assign(event, { clientX: x, clientY: y, sourceCapabilities: { firesTouchEvents: true } });
        const originalStop = event.stopPropagation.bind(event);
        let stopCalls = 0;
        event.stopPropagation = () => {
            stopCalls += 1;
            originalStop();
        };
        target.dispatchEvent(event);
        (event as any).stopPropagationCalls = stopCalls;
        return event;
    }

    test('非 editable 目标不显示编辑菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const div = doc.createElement('div');
        doc.body.appendChild(div);
        doc.elementFromPoint = () => div;

        doc.dispatchEvent(press(70, 90));
        jest.advanceTimersByTime(670);
        doc.dispatchEvent(lift(70, 90));

        expect(doc.getElementById('od-edit-menu')).toBeNull();
    });

    test('无宿主标记（浏览器网页等 frame）不显示编辑菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        createTouchLongPressController();

        const input = doc.createElement('input');
        doc.body.appendChild(input);

        dispatchContextMenu(70, 90, input);

        expect(doc.getElementById('od-edit-menu')).toBeNull();
    });

    test('英文环境下编辑菜单为英文文案', () => {
        doc.documentElement.setAttribute('lang', 'en-US');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('input');
        doc.body.appendChild(input);
        dispatchContextMenu(70, 90, input);

        const items = Array.from(doc.getElementById('od-edit-menu').querySelectorAll('.od-edit-menu-label')).map(
            (b: any) => b.textContent
        );
        expect(items).toEqual(['Cut', 'Copy', 'Paste', 'Select All']);
    });

    test('点击复制项经剪贴板桥写出选中文本', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('input');
        input.value = 'abcdef';
        input.selectionStart = 1;
        input.selectionEnd = 4;
        doc.body.appendChild(input);
        dispatchContextMenu(70, 90, input);

        const writeEvents = recordedEvents(win, 'od-clipboard-write');
        const copyBtn = doc.getElementById('od-edit-menu').querySelectorAll('.od-edit-menu-item')[1];
        copyBtn.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
        expect(writeEvents).toHaveLength(1);
        expect(writeEvents[0].detail.text).toBe('bcd');
    });

    test('点击粘贴项经剪贴板桥异步读取并插入文本', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('input');
        input.value = 'abef';
        input.selectionStart = 2;
        input.selectionEnd = 2;
        doc.body.appendChild(input);
        dispatchContextMenu(70, 90, input);

        const readRequests = recordedEvents(win, 'od-clipboard-read');
        const pasteBtn = doc.getElementById('od-edit-menu').querySelectorAll('.od-edit-menu-item')[2];
        pasteBtn.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
        expect(readRequests).toHaveLength(1);
        const requestId = readRequests[0].detail.requestId;

        // 模拟隔离世界剪贴板桥回填结果
        win.dispatchEvent(new win.CustomEvent('od-clipboard-read-result', { detail: { requestId, text: 'cd' } }));
        expect(input.value).toBe('abcdef');
    });

    test('菜单外按下指针时关闭编辑菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('input');
        doc.body.appendChild(input);
        dispatchContextMenu(70, 90, input);
        expect(doc.getElementById('od-edit-menu')).toBeTruthy();

        doc.body.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
        expect(doc.getElementById('od-edit-menu')).toBeNull();
    });

    test('抬手取消长按（进度未满）', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(100, 100));
        doc.dispatchEvent(lift(100, 100));
        jest.advanceTimersByTime(1000);

        expect(contextEvents).toHaveLength(0);
    });

    test('取消淡出期间重新按下，旧移除回调不误删新指示器', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        doc.dispatchEvent(press(100, 100));
        doc.dispatchEvent(move(150, 100));
        doc.dispatchEvent(lift(150, 100));

        doc.dispatchEvent(press(200, 200));
        jest.advanceTimersByTime(150);

        const indicator = doc.getElementById('od-longpress-indicator');
        expect(indicator).toBeTruthy();
        expect(indicator.classList.contains('cancelling')).toBe(false);
    });

    test('触发反馈期间重新按下，旧移除回调不误删新指示器', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(100, 100));
        jest.advanceTimersByTime(670);
        doc.dispatchEvent(lift(100, 100));
        doc.dispatchEvent(press(200, 200));
        jest.advanceTimersByTime(750);
        doc.dispatchEvent(lift(200, 200));

        const indicator = doc.getElementById('od-longpress-indicator');
        expect(indicator).toBeTruthy();
        // 新一轮长按照常触发
        expect(contextEvents).toHaveLength(2);
    });

    test('第二根手指按下取消长按', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(100, 100));
        doc.dispatchEvent(
            touch(
                'touchstart',
                [
                    { identifier: 1, clientX: 100, clientY: 100 },
                    { identifier: 2, clientX: 200, clientY: 200 }
                ],
                [{ identifier: 2, clientX: 200, clientY: 200 }]
            )
        );
        jest.advanceTimersByTime(1000);

        expect(contextEvents).toHaveLength(0);
    });

    test('触发后拦截模拟 mouse 与 pointer 序列，click 后解除拦截', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        doc.dispatchEvent(press(50, 60));
        jest.advanceTimersByTime(670);
        doc.dispatchEvent(lift(50, 60));

        const target = doc.createElement('div');
        doc.body.appendChild(target);

        // linkedom 的 stopPropagation 不阻断同元素后续 listener，故仅验证 preventDefault。
        // pointerdown 也在拦截列表：否则抬手后的模拟 pointerdown 会立刻关掉刚弹出的菜单
        const pointerDown = new win.Event('pointerdown', { bubbles: true, cancelable: true });
        target.dispatchEvent(pointerDown);
        expect(pointerDown.defaultPrevented).toBe(true);

        const mouseDown = new win.Event('mousedown', { bubbles: true, cancelable: true });
        target.dispatchEvent(mouseDown);
        expect(mouseDown.defaultPrevented).toBe(true);

        const click = new win.Event('click', { bubbles: true, cancelable: true });
        target.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
        // 拦截到 click 后应解除，后续点击不受影响
        const nextClick = new win.Event('click', { bubbles: true, cancelable: true });
        target.dispatchEvent(nextClick);
        expect(nextClick.defaultPrevented).toBe(false);
    });

    test('拦截窗口在 400ms 后自行解除，不吃掉后续真实点击', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        doc.dispatchEvent(press(50, 60));
        jest.advanceTimersByTime(670);
        doc.dispatchEvent(lift(50, 60));

        jest.advanceTimersByTime(450);

        const target = doc.createElement('div');
        doc.body.appendChild(target);
        const click = new win.Event('click', { bubbles: true, cancelable: true });
        target.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(false);
    });

    test('重复安装幂等：第二次调用不叠加监听与定时器', () => {
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();
        createTouchLongPressController();

        const contextEvents = recordedEvents(win, 'contextmenu');
        doc.dispatchEvent(press(10, 10));
        jest.advanceTimersByTime(670);
        doc.dispatchEvent(lift(10, 10));

        expect(contextEvents).toHaveLength(1);
    });

    test('编辑菜单视觉对齐 ctx-menu：--ctx-* 变量、图标、分隔线（深浅色随主题）', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('input');
        doc.body.appendChild(input);
        dispatchContextMenu(70, 90, input);

        const menu = doc.getElementById('od-edit-menu');
        expect(menu).toBeTruthy();
        // 分组：剪切/复制/粘贴 + 分隔线 + 全选
        const children = Array.from(menu.children).map((c: any) => c.className);
        expect(children).toEqual([
            'od-edit-menu-item',
            'od-edit-menu-item',
            'od-edit-menu-item',
            'od-edit-menu-divider',
            'od-edit-menu-item'
        ]);
        // 每个条目带图标
        expect(menu.querySelectorAll('.od-edit-menu-icon')).toHaveLength(4);
        // 每个条目右侧显示快捷键
        const shortcuts = Array.from(menu.querySelectorAll('.od-edit-menu-shortcut')).map((s: any) => s.textContent);
        expect(shortcuts).toEqual(['Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'Ctrl+A']);

        const styleText = doc.getElementById('od-longpress-style').textContent;
        // 同一套 --ctx-* 变量（跟随 html[data-theme='dark'] 深浅色切换）
        expect(styleText).toContain('var(--ctx-bg, #ffffff)');
        expect(styleText).toContain('var(--ctx-border, #e7e5e2)');
        expect(styleText).toContain('var(--ctx-hover, #f0efec)');
        expect(styleText).toContain('var(--ctx-sep, #efeeea)');
        // 快捷键样式（右侧对齐，对齐 ctx-shortcut 观感）
        expect(styleText).toContain('.od-edit-menu-shortcut');
        expect(styleText).toContain('var(--ctx-ink4, #b4afa9)');
    });

    test('编辑菜单以 popover 进入 top layer（任何浮层都盖不住）', () => {
        // linkedom 无 popover API，验证注入脚本的置顶手段与降级写法
        expect(TOUCH_LONG_PRESS_SCRIPT).toContain("setAttribute('popover', 'manual')");
        expect(TOUCH_LONG_PRESS_SCRIPT).toContain('showPopover');
        // 覆盖 popover 的 UA 默认样式（居中/全屏 inset），保证按 left/top 定位
        const styleProbe = doc.createElement('div');
        doc.body.appendChild(styleProbe);
        const styleText = (() => {
            doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
            createTouchLongPressController();
            doc.dispatchEvent(new win.Event('touchstart'));
            return doc.getElementById('od-longpress-style')?.textContent || '';
        })();
        if (styleText) {
            expect(styleText).toContain('inset: auto');
            expect(styleText).toContain('margin: 0');
        }
    });

    test('Escape 关闭编辑菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('input');
        doc.body.appendChild(input);
        dispatchContextMenu(70, 90, input);
        expect(doc.getElementById('od-edit-menu')).toBeTruthy();

        doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(doc.getElementById('od-edit-menu')).toBeNull();
    });

    test('开始输入（普通按键）时关闭编辑菜单（焦点本就在输入框，无 pointerdown 可依赖）', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('input');
        doc.body.appendChild(input);
        dispatchContextMenu(70, 90, input);
        expect(doc.getElementById('od-edit-menu')).toBeTruthy();

        doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        expect(doc.getElementById('od-edit-menu')).toBeNull();
    });

    test('单独按下修饰键不关闭编辑菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('input');
        doc.body.appendChild(input);
        dispatchContextMenu(70, 90, input);
        expect(doc.getElementById('od-edit-menu')).toBeTruthy();

        for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
            doc.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }));
        }
        expect(doc.getElementById('od-edit-menu')).toBeTruthy();
    });

    test('beforeinput（IME 确认等输入事件）关闭编辑菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const input = doc.createElement('input');
        doc.body.appendChild(input);
        dispatchContextMenu(70, 90, input);
        expect(doc.getElementById('od-edit-menu')).toBeTruthy();

        doc.dispatchEvent(new win.Event('beforeinput', { bubbles: true }));
        expect(doc.getElementById('od-edit-menu')).toBeNull();
    });

    test('只读文本区（代码/markdown 预览）选中文字后右键弹出编辑菜单，剪切/粘贴置灰', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const pre = doc.createElement('pre');
        const code = doc.createElement('span');
        pre.appendChild(code);
        doc.body.appendChild(pre);
        // 模拟选区：非 collapsed 且有文本
        Object.defineProperty(win, 'getSelection', {
            value: () => ({ isCollapsed: false, toString: () => 'const a = 1', selectAllChildren: () => {} }),
            configurable: true
        });

        dispatchContextMenu(120, 200, code);

        const menu = doc.getElementById('od-edit-menu');
        expect(menu).toBeTruthy();
        const buttons = Array.from(menu.querySelectorAll('.od-edit-menu-item'));
        expect(buttons).toHaveLength(4);
        // cut / paste 置灰，copy / selectAll 可用
        expect(buttons[0].classList.contains('disabled')).toBe(true);
        expect(buttons[1].classList.contains('disabled')).toBe(false);
        expect(buttons[2].classList.contains('disabled')).toBe(true);
        expect(buttons[3].classList.contains('disabled')).toBe(false);
    });

    test('只读文本区无选区时右键不弹编辑菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const pre = doc.createElement('pre');
        doc.body.appendChild(pre);
        Object.defineProperty(win, 'getSelection', {
            value: () => ({ isCollapsed: true, toString: () => '', selectAllChildren: () => {} }),
            configurable: true
        });

        dispatchContextMenu(120, 200, pre);

        expect(doc.getElementById('od-edit-menu')).toBeNull();
    });

    test('只读选区场景复制选中文本到剪贴板', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const pre = doc.createElement('pre');
        doc.body.appendChild(pre);
        Object.defineProperty(win, 'getSelection', {
            value: () => ({ isCollapsed: false, toString: () => 'selected code', selectAllChildren: () => {} }),
            configurable: true
        });

        dispatchContextMenu(120, 200, pre);
        const writeEvents = recordedEvents(win, 'od-clipboard-write');
        const copyBtn = doc.getElementById('od-edit-menu').querySelectorAll('.od-edit-menu-item')[1];
        copyBtn.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
        expect(writeEvents).toHaveLength(1);
        expect(writeEvents[0].detail.text).toBe('selected code');
    });

    test('只读选区场景全选内容容器', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const pre = doc.createElement('pre');
        const code = doc.createElement('span');
        pre.appendChild(code);
        doc.body.appendChild(pre);
        const selectedScopes: any[] = [];
        Object.defineProperty(win, 'getSelection', {
            value: () => ({
                isCollapsed: false,
                toString: () => 'x',
                selectAllChildren: (scope: any) => selectedScopes.push(scope)
            }),
            configurable: true
        });

        dispatchContextMenu(120, 200, code);
        const selectAllBtn = doc.getElementById('od-edit-menu').querySelectorAll('.od-edit-menu-item')[3];
        selectAllBtn.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
        // closest('pre,...') 命中 pre 容器
        expect(selectedScopes).toHaveLength(1);
        expect(selectedScopes[0]).toBe(pre);
    });

    test('Shadow DOM 内的 markdown 预览（composedPath 命中文本容器）右键弹出只读菜单', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        // 模拟 open shadow 内预览：document 收到的 target 被重定向为 host，
        // composedPath 才能拿到 shadow 内真实节点
        const host = doc.createElement('div');
        const markdownBody = doc.createElement('div');
        markdownBody.className = 'markdown-body';
        const span = doc.createElement('span');
        doc.body.appendChild(host);
        // 模拟 open shadow 内节点：getRootNode 返回 ShadowRoot（nodeType 11）
        (markdownBody as any).getRootNode = () => ({ nodeType: 11 });
        (span as any).getRootNode = () => ({ nodeType: 11 });

        const event = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        Object.assign(event, { clientX: 260, clientY: 320 });
        (event as any).composedPath = () => [span, markdownBody, host, doc.body, doc.documentElement, doc];
        host.dispatchEvent(event);

        const menu = doc.getElementById('od-edit-menu');
        expect(menu).toBeTruthy();
        expect(menu.style.left).toBe('260px');
        expect(menu.style.top).toBe('320px');
        // 只读：剪切/粘贴置灰
        const buttons = Array.from(menu.querySelectorAll('.od-edit-menu-item'));
        expect(buttons[0].classList.contains('disabled')).toBe(true);
        expect(buttons[1].classList.contains('disabled')).toBe(false);
    });

    test('Shadow DOM 内的 Ace 编辑器：复制/全选经模拟快捷键交给 Ace 处理', () => {
        doc.documentElement.setAttribute('lang', 'zh-CN');
        doc.documentElement.setAttribute('data-od-lp-edit-menu', '1');
        createTouchLongPressController();

        const aceEditor = doc.createElement('div');
        aceEditor.className = 'ace_editor';
        const line = doc.createElement('div');
        line.className = 'ace_line';
        const textInput = doc.createElement('textarea');
        textInput.className = 'ace_text-input';
        aceEditor.appendChild(line);
        aceEditor.appendChild(textInput);
        doc.body.appendChild(aceEditor);
        // 模拟 open shadow 内节点
        (aceEditor as any).getRootNode = () => ({ nodeType: 11 });
        (line as any).getRootNode = () => ({ nodeType: 11 });

        const keyEvents: string[] = [];
        textInput.addEventListener('keydown', (e: any) => keyEvents.push(`${e.key}:${e.ctrlKey}`));

        const openMenu = () => {
            const event = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
            Object.assign(event, { clientX: 10, clientY: 20 });
            (event as any).composedPath = () => [line, aceEditor, doc.body, doc.documentElement, doc];
            line.dispatchEvent(event);
        };

        openMenu();
        const menu = doc.getElementById('od-edit-menu');
        expect(menu).toBeTruthy();
        const buttons = Array.from(menu.querySelectorAll('.od-edit-menu-item'));
        // 复制
        buttons[1].dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
        // 全选（重新打开菜单）
        openMenu();
        const selectAllBtn = doc.getElementById('od-edit-menu').querySelectorAll('.od-edit-menu-item')[3];
        selectAllBtn.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));

        expect(keyEvents).toEqual(['c:true', 'a:true']);
    });

    test('指示器包含进度环、底环与样式表，动画时长与长按阈值一致', () => {
        createTouchLongPressController();

        doc.dispatchEvent(press(10, 10));
        jest.advanceTimersByTime(SHOW_DELAY_MS);
        const indicator = doc.getElementById('od-longpress-indicator');
        expect(indicator).toBeTruthy();
        // 进度环：SVG circle 通过 stroke-dashoffset 动画填充；触发反馈作用于内层
        expect(indicator.querySelector('.ring-fg')).toBeTruthy();
        expect(indicator.querySelector('.ring-halo')).toBeTruthy();
        expect(indicator.querySelector('.od-longpress-ring')).toBeTruthy();
        expect(doc.getElementById('od-longpress-style')).toBeTruthy();

        const styleText = doc.getElementById('od-longpress-style').textContent;
        expect(styleText).toContain('od-lp-progress');
        expect(styleText).toContain('550ms');
        // 80px：大于手指接触面，圆环露在手指外缘可见
        expect(styleText).toContain('80px');
        // 顶部起点旋转（进度从 12 点方向顺时针填充）；进度从圆环显示时从 0 起算
        expect(styleText).toContain('rotate(-90deg)');
        expect(styleText).not.toContain('animation-delay');
        // 颜色对齐 taskview markdown 行内代码：底环 accent-soft、前景 accent
        expect(styleText).toContain('var(--chat-accent-soft, #fdeeec)');
        expect(styleText).toContain('var(--chat-accent, #df4436)');
        // 触发反馈与取消淡出
        expect(styleText).toContain('od-lp-fired');
        expect(styleText).toContain('cancelling');
    });
});

describe('TOUCH_LONG_PRESS_SCRIPT 注入脚本', () => {
    test('脚本是自包含 IIFE：语法有效且不引用模块导入', () => {
        expect(TOUCH_LONG_PRESS_SCRIPT).toContain('createTouchLongPressController');
        expect(TOUCH_LONG_PRESS_SCRIPT).not.toMatch(/\bimport\s|\bexport\s/);
        expect(() => new Function(TOUCH_LONG_PRESS_SCRIPT)).not.toThrow();
    });
});

describe('触摸长按右键：全局接线', () => {
    const read = (rel: string): string => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

    test('preload.js 安装编辑菜单标记与剪贴板桥', () => {
        const source = read('src/renderer/preload.js');
        expect(source).toContain("setAttribute('data-od-lp-edit-menu', '1')");
        expect(source).toContain("addEventListener('od-clipboard-write'");
        expect(source).toContain("addEventListener('od-clipboard-read'");
        // 渲染器默认沙箱化，preload 的 electron 模块不含 clipboard：
        // 剪贴板读写必须经主进程 IPC，不得直接引用 clipboard 模块
        expect(source).toContain("invoke('clipboard:writeText'");
        expect(source).toContain("invoke('clipboard:readText'");
        expect(source).not.toContain('clipboard.writeText');
        expect(source).not.toContain('clipboard.readText');
        // 浏览器 webview preload 不带编辑菜单与剪贴板桥（网页不得经伪造事件读剪贴板）
        const webviewPreload = read('src/renderer/webviewPreload.js');
        expect(webviewPreload).not.toContain('od-clipboard-read');
        expect(webviewPreload).not.toContain('data-od-lp-edit-menu');
    });

    test('main.ts 注册主进程剪贴板 IPC（沙箱渲染器的剪贴板代执行）', () => {
        const mainSource = read('src/main/main.ts');
        expect(mainSource).toContain("ipcMain.handle('clipboard:writeText'");
        expect(mainSource).toContain("ipcMain.handle('clipboard:readText'");
    });

    test('main.ts 注入长按脚本且不再弹原生编辑菜单（右键与长按统一自绘）', () => {
        const mainSource = read('src/main/main.ts');
        expect(mainSource).toContain('installTouchLongPress(contents)');
        expect(mainSource).not.toContain("t('contextmenu.cut')");
        expect(mainSource).not.toContain('isRecentTouch');
        const modSource = read('src/main/windows/touch-long-press.ts');
        expect(modSource).not.toContain('buildFromTemplate');
        expect(modSource).not.toContain('sendInputEvent');
    });

    test('sidebar 子菜单支持触摸点击显式展开（修复触摸点击"开发者"直接关菜单）', () => {
        const sidebarSource = read('src/renderer/components/sidebar.js');
        expect(sidebarSource).toContain("submenuBtn?.addEventListener('click'");
        expect(sidebarSource).toContain("classList.toggle('is-submenu-open')");
        const css = read('src/renderer/styles/context-menu.css');
        expect(css).toContain('.ctx-submenu-wrap.is-submenu-open > .ctx-submenu');
    });

    test('拖拽/缩放表面统一标记 data-od-no-longpress（触摸长按脚本按下即跳过）', () => {
        // 窗口边缘缩放感应条（Linux 阴影窗口）
        const shadowResize = read('src/renderer/components/windowShadowResize.ts');
        expect(shadowResize).toContain('dataset.odNoLongpress');

        // 沉浸桌面：卡片拖拽区/缩放手柄、悬浮窗标题栏/缩放手柄
        const desktop = read('src/renderer/components/desktop/immersiveDesktop.ts');
        const marks = desktop.match(/data-od-no-longpress="1"/g) || [];
        expect(marks.length).toBeGreaterThanOrEqual(4);

        // 分栏分割线（Shadow DOM 内，脚本经 composedPath 扫描命中）
        expect(read('src/renderer/components/splitter.js')).toContain('data-od-no-longpress');

        // 注入脚本按标记跳过手势，并带 hold 期禁选样式
        expect(TOUCH_LONG_PRESS_SCRIPT).toContain('data-od-no-longpress');
        expect(TOUCH_LONG_PRESS_SCRIPT).toContain('od-lp-holding');
        expect(TOUCH_LONG_PRESS_SCRIPT).toContain('-webkit-user-select: none');
    });
});
