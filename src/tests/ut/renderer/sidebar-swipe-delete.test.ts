import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import {
    attachSidebarSwipeDelete,
    clampSwipeOffset,
    resolveSwipeAxis,
    shouldRevealSwipe
} from '../../../renderer/sidebarSwipeDelete.js';

/**
 * 侧边栏任务列表「触摸左滑 → 圆形删除按钮」手势。行为约定：
 * - 位移未过门槛不判轴（继续观察，不能当放弃）；横向明显占优才锁定左滑，
 *   否则锁定纵向并放弃手势（交回原生列表滚动）；
 * - 锁定横向后内容层只跟随向左位移，超过露出阈值时按钮提前露出但不可点击；
 * - 松手位移达到阈值停在展开位并保持可点击，未达到则回弹关闭；
 * - 保持展开的阈值必须大于触摸长按手势的位移容差，两个手势按位移互斥；
 * - 松手后 Chromium 补发的合成 click 被一次性吞掉，避免左滑刚结束就打开任务，
 *   也保证落在删除按钮上的那次合成 click 不会直接触发删除；
 * - 展开态排他：触摸另一行、鼠标按下（含右键）、按 Esc、点击行外区域都会收起；展开态点行内其它区域只收起；
 * - 行由 innerHTML 重渲染，展开态在保留窗口内按任务 id 迁移到新节点，刷新不会收走删除按钮；
 *   超过窗口或任务已不在列表则不再复活。
 */

const AXIS_LOCK_PX = 8;
/** 触摸长按手势的位移容差（touchLongPressScript.CANCEL_SLOP_PX），左滑保持展开必须大于它 */
const LONG_PRESS_SLOP_PX = 36;
const REVEAL_PX = 40;
const OPEN_OFFSET_PX = 28;
const MAX_OFFSET_PX = 56;

let win: any;
let doc: any;

function touch(type: string, touches: any[], changed: any[]): Event {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { touches, changedTouches: changed });
    return event;
}

function point(x: number, y: number, id = 1) {
    return { identifier: id, clientX: x, clientY: y };
}

function press(x: number, y: number, id = 1): Event {
    return touch('touchstart', [point(x, y, id)], [point(x, y, id)]);
}

function move(x: number, y: number, id = 1): Event {
    return touch('touchmove', [point(x, y, id)], [point(x, y, id)]);
}

function lift(x: number, y: number, id = 1): Event {
    return touch('touchend', [], [point(x, y, id)]);
}

function click(): Event {
    return new win.Event('click', { bubbles: true, cancelable: true });
}

function mouseDown(button = 0): Event {
    const event = new win.Event('mousedown', { bubbles: true, cancelable: true });
    (event as any).button = button;
    return event;
}

function key(keyName: string): Event {
    const event = new win.Event('keydown', { bubbles: true, cancelable: true });
    (event as any).key = keyName;
    return event;
}

function setupDom(rowsHtml = ''): void {
    const parsed = parseHTML(
        `<!doctype html><html><head></head><body><div id="task-list-container">${rowsHtml}</div></body></html>`
    );
    win = parsed.window;
    doc = parsed.window.document;
    Object.assign(globalThis, { window: win, document: doc });
}

function taskRowHtml(taskId: string, name: string): string {
    return `
        <div class="task-item sb-task-row" data-task_id="${taskId}" data-depth="0">
            <button type="button" class="sb-swipe-delete" data-task_id="${taskId}"></button>
            <div class="sb-task-row-main"><span class="sb-task-name">${name}</span></div>
        </div>`;
}

/** 模拟一次在任务名称上的触摸轨迹：起点 (200,100)，横向位移 dx、纵向位移 dy */
function swipe(row: any, dx: number, dy = 0, steps = 6): void {
    const target = row.querySelector('.sb-task-name') || row;
    target.dispatchEvent(press(200, 100));
    for (let i = 1; i <= steps; i++) {
        target.dispatchEvent(move(200 + (dx * i) / steps, 100 + (dy * i) / steps));
    }
    target.dispatchEvent(lift(200 + dx, 100 + dy));
}

function contentTransform(row: any): string {
    return row.querySelector('.sb-task-row-main').style.transform || '';
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('左滑手势判定', () => {
    test('位移未过门槛不判轴，横向占优判 x，纵向占优判 y', () => {
        expect(resolveSwipeAxis(3, 2)).toBe(null);
        expect(resolveSwipeAxis(-AXIS_LOCK_PX, 0)).toBe('x');
        expect(resolveSwipeAxis(0, AXIS_LOCK_PX)).toBe('y');
        // 斜向拖动以纵向为主时交回列表滚动
        expect(resolveSwipeAxis(-9, -20)).toBe('y');
        expect(resolveSwipeAxis(-20, -9)).toBe('x');
    });

    test('只接受向左位移，向右钳到 0，超出最大位移后钳制', () => {
        expect(clampSwipeOffset(120)).toBe(0);
        expect(clampSwipeOffset(-12)).toBe(-12);
        expect(clampSwipeOffset(-MAX_OFFSET_PX)).toBe(-MAX_OFFSET_PX);
        expect(clampSwipeOffset(-MAX_OFFSET_PX - 40)).toBe(-MAX_OFFSET_PX);
    });

    test('松手时按阈值决定是否保持展开', () => {
        expect(shouldRevealSwipe(-REVEAL_PX)).toBe(true);
        expect(shouldRevealSwipe(-(REVEAL_PX - 1))).toBe(false);
        expect(shouldRevealSwipe(0)).toBe(false);
    });
});

describe('左滑删除手势', () => {
    let container: any;
    let row: any;
    let deletes: string[];
    let controller: any;

    function mount(rowsHtml = taskRowHtml('t1', '任务一') + taskRowHtml('t2', '任务二')): void {
        setupDom(rowsHtml);
        container = doc.getElementById('task-list-container');
        row = container.querySelector('.task-item[data-task_id="t1"]');
        deletes = [];
        controller = attachSidebarSwipeDelete(container, { onDelete: (id: string) => deletes.push(id) });
    }

    test('左滑达到阈值后停在展开位，删除按钮进入可点击态', () => {
        mount();
        swipe(row, -55);
        expect(row.classList.contains('is-swipe-open')).toBe(true);
        expect(row.classList.contains('is-swipe-peek')).toBe(true);
        expect(contentTransform(row)).toBe(`translateX(-${OPEN_OFFSET_PX}px)`);
    });

    test('左滑未达阈值则回弹关闭，不留下位移', () => {
        mount();
        swipe(row, -12);
        expect(row.classList.contains('is-swipe-open')).toBe(false);
        expect(row.classList.contains('is-swipe-peek')).toBe(false);
        expect(contentTransform(row)).toBe('');
    });

    test('每步位移都小于判轴门槛时左滑依然成立（触摸屏 touchmove 密集场景）', () => {
        mount();
        // 20 步 × 3px：没有任何一步超过 8px 判轴门槛，手势必须照常完成
        swipe(row, -60, 0, 20);
        expect(row.classList.contains('is-swipe-dragging')).toBe(false);
        expect(row.classList.contains('is-swipe-open')).toBe(true);
        expect(contentTransform(row)).toBe(`translateX(-${OPEN_OFFSET_PX}px)`);
    });

    test('位移未超过触摸长按容差时不保持展开（两个手势按位移互斥）', () => {
        mount();
        // 缓慢左移 36px 后按住不放：长按圆环仍会走完进度，左滑不得同时展开
        swipe(row, -LONG_PRESS_SLOP_PX);
        expect(row.classList.contains('is-swipe-open')).toBe(false);
        expect(contentTransform(row)).toBe('');
        swipe(row, -(LONG_PRESS_SLOP_PX + 4));
        expect(row.classList.contains('is-swipe-open')).toBe(true);
    });

    test('行内重命名输入框上的横向拖动不触发滑动（属于选词/移光标）', () => {
        mount();
        row.querySelector('.sb-task-row-main').innerHTML = '<input class="sb-task-name" type="text" value="重命名中">';
        swipe(row, -60);
        expect(row.classList.contains('is-swipe-open')).toBe(false);
        expect(row.classList.contains('is-swipe-dragging')).toBe(false);
        expect(contentTransform(row)).toBe('');
    });

    test('拖动过程跟随手指，松手前按钮已露出但不可点击', () => {
        mount();
        const name = row.querySelector('.sb-task-name');
        name.dispatchEvent(press(200, 100));
        name.dispatchEvent(move(180, 100));
        expect(row.classList.contains('is-swipe-dragging')).toBe(true);
        expect(contentTransform(row)).toBe('translateX(-20px)');
        expect(row.classList.contains('is-swipe-peek')).toBe(true);
        expect(row.classList.contains('is-swipe-open')).toBe(false);
        name.dispatchEvent(lift(180, 100));
    });

    test('纵向滑动放弃手势，不加任何滑动状态（交回列表滚动）', () => {
        mount();
        swipe(row, 4, -60);
        expect(row.classList.contains('is-swipe-dragging')).toBe(false);
        expect(row.classList.contains('is-swipe-peek')).toBe(false);
        expect(contentTransform(row)).toBe('');
    });

    test('向右滑动不产生位移', () => {
        mount();
        swipe(row, 60);
        expect(contentTransform(row)).toBe('');
        expect(row.classList.contains('is-swipe-open')).toBe(false);
    });

    test('松手后的合成 click 被吞掉，不会打开任务', () => {
        mount();
        swipe(row, -55);
        // linkedom 在 capture 阶段仍会调用目标自身监听器，真实浏览器里该 click 根本到不了任务行，
        // 因此断言拦截方已 preventDefault（行侧打开任务的动作被取消）
        const event = click();
        row.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    test('落在删除按钮上的合成 click 不会直接删除，随后的真实点击才删除', () => {
        mount();
        swipe(row, -55);
        const button = row.querySelector('.sb-swipe-delete');
        button.dispatchEvent(click());
        expect(deletes).toEqual([]);
        button.dispatchEvent(click());
        expect(deletes).toEqual(['t1']);
    });

    test('合成 click 拦截窗口超时后自动解除，首次点击删除按钮即生效', () => {
        mount();
        swipe(row, -55);
        jest.advanceTimersByTime(400);
        row.querySelector('.sb-swipe-delete').dispatchEvent(click());
        expect(deletes).toEqual(['t1']);
    });

    test('展开态点行内其它区域只收起，不打开任务', () => {
        mount();
        swipe(row, -55);
        row.dispatchEvent(click()); // 合成 click
        const event = click();
        row.querySelector('.sb-task-name').dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(row.classList.contains('is-swipe-open')).toBe(false);
    });

    test('展开态触摸另一行时前一行收起，同一时刻最多一行展开', () => {
        mount();
        const other = container.querySelector('.task-item[data-task_id="t2"]');
        swipe(row, -55);
        swipe(other, -55);
        expect(row.classList.contains('is-swipe-open')).toBe(false);
        expect(contentTransform(row)).toBe('');
        expect(other.classList.contains('is-swipe-open')).toBe(true);
    });

    test('展开态在行外按下即收起', () => {
        mount();
        swipe(row, -55);
        container.dispatchEvent(press(300, 400));
        expect(row.classList.contains('is-swipe-open')).toBe(false);
    });

    test('展开态下鼠标左键点另一行即收起（触摸划出后改用鼠标）', () => {
        mount();
        const other = container.querySelector('.task-item[data-task_id="t2"]');
        swipe(row, -55);
        other.dispatchEvent(mouseDown());
        expect(row.classList.contains('is-swipe-open')).toBe(false);
        expect(contentTransform(row)).toBe('');
    });

    test('展开态下鼠标右键点另一行即收起（右键菜单弹出前收起）', () => {
        mount();
        const other = container.querySelector('.task-item[data-task_id="t2"]');
        swipe(row, -55);
        other.dispatchEvent(mouseDown(2));
        expect(row.classList.contains('is-swipe-open')).toBe(false);
    });

    test('展开态下鼠标在行外按下即收起', () => {
        mount();
        swipe(row, -55);
        container.dispatchEvent(mouseDown());
        expect(row.classList.contains('is-swipe-open')).toBe(false);
    });

    test('展开态下鼠标在展开行内按下不收起（交给 click 收起并拦截打开任务）', () => {
        mount();
        swipe(row, -55);
        row.querySelector('.sb-task-name').dispatchEvent(mouseDown());
        expect(row.classList.contains('is-swipe-open')).toBe(true);
    });

    test('展开态按 Esc 即收起', () => {
        mount();
        swipe(row, -55);
        doc.dispatchEvent(key('Escape'));
        expect(row.classList.contains('is-swipe-open')).toBe(false);
        expect(contentTransform(row)).toBe('');
    });

    test('未展开时按 Esc 不产生任何状态变化', () => {
        mount();
        doc.dispatchEvent(key('Escape'));
        expect(row.classList.contains('is-swipe-open')).toBe(false);
        expect(row.className).toBe('task-item sb-task-row');
    });

    test('Esc 以外的按键不收起展开态', () => {
        mount();
        swipe(row, -55);
        doc.dispatchEvent(key('Enter'));
        expect(row.classList.contains('is-swipe-open')).toBe(true);
    });

    test('展开态在列表重渲染后迁移到新行（刷新不会收走删除按钮）', () => {
        mount();
        swipe(row, -55);
        expect(row.classList.contains('is-swipe-open')).toBe(true);
        // 模拟 reloadTaskList：innerHTML 重建，旧节点整体作废
        container.innerHTML = taskRowHtml('t1', '任务一') + taskRowHtml('t2', '任务二');
        const fresh = container.querySelector('.task-item[data-task_id="t1"]');
        expect(fresh.classList.contains('is-swipe-open')).toBe(false);
        controller.restoreOpenRow();
        expect(fresh.classList.contains('is-swipe-open')).toBe(true);
        expect(fresh.querySelector('.sb-task-row-main').style.transform).toBe(`translateX(-${OPEN_OFFSET_PX}px)`);
    });

    test('重渲染后任务已不在列表时清除展开态，不会在后续刷新里复活', () => {
        mount();
        swipe(row, -55);
        container.innerHTML = taskRowHtml('t2', '任务二');
        controller.restoreOpenRow();
        expect(container.querySelector('.task-item[data-task_id="t2"]').classList.contains('is-swipe-open')).toBe(
            false
        );
        // 任务重新出现也不应复活展开态
        container.innerHTML = taskRowHtml('t1', '任务一');
        controller.restoreOpenRow();
        expect(container.querySelector('.task-item[data-task_id="t1"]').classList.contains('is-swipe-open')).toBe(
            false
        );
    });

    test('跨重渲染恢复后，点击新行的删除按钮仍回调正确的任务 id', () => {
        mount();
        swipe(row, -55);
        container.innerHTML = taskRowHtml('t1', '任务一') + taskRowHtml('t2', '任务二');
        controller.restoreOpenRow();
        const fresh = container.querySelector('.task-item[data-task_id="t1"]');
        // 越过合成 click 拦截窗口，模拟用户抬手后再点删除按钮
        jest.advanceTimersByTime(400);
        fresh.querySelector('.sb-swipe-delete').dispatchEvent(click());
        expect(deletes).toEqual(['t1']);
    });

    test('展开态超过保留窗口后不再复活（避免长期驻留）', () => {
        mount();
        swipe(row, -55);
        jest.advanceTimersByTime(6000);
        container.innerHTML = taskRowHtml('t1', '任务一') + taskRowHtml('t2', '任务二');
        controller.restoreOpenRow();
        expect(container.querySelector('.task-item[data-task_id="t1"]').classList.contains('is-swipe-open')).toBe(
            false
        );
    });

    test('保持展开阈值必须大于触摸长按的位移容差（跨手势互斥契约）', () => {
        const read = (rel: string): string => readFileSync(path.resolve(process.cwd(), rel), 'utf8');
        const longPress = read('src/renderer/touchLongPressScript.ts');
        const swipeSrc = read('src/renderer/sidebarSwipeDelete.ts');
        const slop = Number(/CANCEL_SLOP_PX\s*=\s*(\d+)/.exec(longPress)?.[1]);
        const reveal = Number(/const REVEAL_PX\s*=\s*(\d+)/.exec(swipeSrc)?.[1]);
        expect(slop).toBeGreaterThan(0);
        expect(reveal).toBeGreaterThan(slop);
    });

    test('destroy 后不再响应滑动', () => {
        mount();
        controller.destroy();
        swipe(row, -55);
        expect(row.classList.contains('is-swipe-open')).toBe(false);
    });
});
