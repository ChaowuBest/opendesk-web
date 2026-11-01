// 多选/框选控制器的最小 DOM 测试替身：模拟外层列表 + 展开分组内层 body 的双层滚动
// 容器与任务行几何，支持鼠标框选（mousedown/mousemove/mouseup）与触摸事件派发。
// DOM 结构复刻 sidebar 真实层级：.groups（外层滚动）> details.sb-task-group[open]
// > .sb-task-group-body（内层滚动）> .row 任务行，控制器的选择器才能真实命中。
// linkedom 没有 MouseEvent/TouchEvent/真实布局：用 Event 混入坐标字段；行 rect 由
// spec.top 与两个容器的 scrollTop 实时推算，改 scrollTop 即移动行。
// 注意不能把「来自行」的事件直接 dispatch 到 document：linkedom 会把 event.target
// 重写为 dispatch 目标，必须从行元素上派发让它冒泡（见 touchStart/mouseDown）。

import type { Window as LinkedomWindow } from 'linkedom';

export interface MarqueeRowSpec {
    id: string;
    top: number;
}

const ROW_HEIGHT = 18;
const OUTER_RECT = { top: 0, bottom: 200, left: 0, right: 200 };
const BODY_RECT = { top: 20, bottom: 190, left: 0, right: 200 };

export function createMarqueeHarness(rows: MarqueeRowSpec[], win: LinkedomWindow) {
    const { document } = win;
    const container = document.createElement('div');
    const groups = document.createElement('div');
    groups.className = 'groups';
    const groupEl = document.createElement('details');
    groupEl.className = 'sb-task-group';
    groupEl.setAttribute('open', '');
    const body = document.createElement('div');
    body.className = 'sb-task-group-body';
    groupEl.appendChild(body);
    groups.appendChild(groupEl);
    container.appendChild(groups);

    const asRect = (base: { top: number; bottom: number; left: number; right: number }) =>
        ({
            left: base.left,
            top: base.top,
            right: base.right,
            bottom: base.bottom,
            width: base.right - base.left,
            height: base.bottom - base.top,
            x: base.left,
            y: base.top,
            toJSON: () => ({})
        }) as DOMRect;

    groups.getBoundingClientRect = () => asRect(OUTER_RECT);
    body.getBoundingClientRect = () => asRect(BODY_RECT);
    // linkedom 的 scrollTop 不可滚动，重定义为可写属性供控制器读写与断言
    for (const el of [groups, body]) {
        Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
    }

    for (const spec of rows) {
        appendRow(spec);
    }
    document.body.appendChild(container);

    function appendRow(spec: MarqueeRowSpec): void {
        const row = document.createElement('div');
        row.className = 'row';
        row.dataset.task_id = spec.id;
        row.getBoundingClientRect = () => {
            const top = BODY_RECT.top + spec.top - body.scrollTop - groups.scrollTop;
            return asRect({ top, bottom: top + ROW_HEIGHT, left: OUTER_RECT.left, right: OUTER_RECT.right });
        };
        body.appendChild(row);
    }

    const makeTouch = (identifier: number, clientX: number, clientY: number) =>
        ({
            identifier,
            clientX,
            clientY,
            target: container
        }) as Touch;

    function makeTouchEvent(type: string, touches: Touch[], changedTouches: Touch[], dispatchTarget: HTMLElement) {
        const event = new win.Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
        Object.defineProperties(event, {
            touches: { value: touches },
            changedTouches: { value: changedTouches }
        });
        dispatchTarget.dispatchEvent(event);
        return event;
    }

    function makeMouseEvent(type: string, x: number, y: number, buttons = type === 'mouseup' ? 0 : 1) {
        const event = new win.Event(type, { bubbles: true, cancelable: true }) as MouseEvent;
        Object.defineProperties(event, {
            clientX: { value: x },
            clientY: { value: y },
            button: { value: 0 },
            buttons: { value: buttons },
            ctrlKey: { value: false },
            metaKey: { value: false },
            shiftKey: { value: false }
        });
        return event;
    }

    return {
        container,
        groups,
        body,
        document,
        selection: new Set<string>(),
        get outerScrollTop() {
            return groups.scrollTop;
        },
        get innerScrollTop() {
            return body.scrollTop;
        },
        mouseDown(target: Element, x: number, y: number): MouseEvent {
            const event = makeMouseEvent('mousedown', x, y);
            (target as HTMLElement).dispatchEvent(event);
            return event;
        },
        /** 模拟 reloadTaskList：按原 spec 重建全部行节点（旧节点全部游离） */
        rebuild(): void {
            body.innerHTML = '';
            for (const spec of rows) appendRow(spec);
        },
        mouseMove(x: number, y: number, buttons?: number): MouseEvent {
            const event = makeMouseEvent('mousemove', x, y, buttons);
            document.dispatchEvent(event);
            return event;
        },
        mouseUp(x: number, y: number): MouseEvent {
            const event = makeMouseEvent('mouseup', x, y);
            document.dispatchEvent(event);
            return event;
        },
        touchStart(rowId: string, clientX: number, clientY: number): TouchEvent {
            const row = container.querySelector(`.row[data-task_id="${rowId}"]`) as HTMLElement;
            const touch = makeTouch(7, clientX, clientY);
            return makeTouchEvent('touchstart', [touch], [touch], row);
        },
        touchMove(clientX: number, clientY: number): TouchEvent {
            const touch = makeTouch(7, clientX, clientY);
            return makeTouchEvent('touchmove', [touch], [touch], container);
        },
        touchEnd(identifier: number): TouchEvent {
            return makeTouchEvent('touchend', [], [makeTouch(identifier, 0, 0)], container);
        }
    };
}
