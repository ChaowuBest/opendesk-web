// 侧边栏任务多选与框选测试：
// 1. 纯判定逻辑（sidebarMultiSelect.ts）：不依赖 DOM 的边界验证；
// 2. 控制器交互（sidebarMultiSelectController.ts）：linkedom 隔离文档 +
//    sidebar-marquee-harness 几何替身，直连真实控制器验证鼠标/触摸契约。
// 覆盖：Ctrl 点选、Shift 区间选、框选进入多选的门槛（选区覆盖 >= 2 个任务）。
import { describe, expect, jest, test } from '@jest/globals';
import {
    ctrlToggleId,
    rangeByAnchor,
    shouldStartMarquee,
    MIN_MARQUEE_SELECTION
} from '../../../renderer/sidebarMultiSelect.js';

describe('sidebarMultiSelect 纯逻辑', () => {
    describe('ctrlToggleId', () => {
        test('已选中则移除，未选中则添加', () => {
            expect(ctrlToggleId(new Set(['a', 'b']), 'a')).toEqual(new Set(['b']));
            expect(ctrlToggleId(new Set(['b']), 'a')).toEqual(new Set(['a', 'b']));
        });

        test('返回新集合，不修改入参', () => {
            const source = new Set(['a']);
            const result = ctrlToggleId(source, 'b');
            expect(source.has('b')).toBe(false);
            expect(result.has('b')).toBe(true);
        });
    });

    describe('rangeByAnchor', () => {
        test('锚点与目标间所有 id（含两端）都进入选区', () => {
            const ordered = ['t1', 't2', 't3', 't4', 't5'];
            expect(rangeByAnchor(ordered, 't2', 't4')).toEqual(new Set(['t2', 't3', 't4']));
        });

        test('反向区间也成立（锚点可以不是列表顺序中的前一个）', () => {
            const shuffled = ['t5', 't3', 't1', 't4', 't2'];
            expect(rangeByAnchor(shuffled, 't2', 't4')).toEqual(new Set(['t4', 't2']));
        });

        test('锚点不在列表中时仅选中目标', () => {
            const ordered = ['t1', 't2', 't3'];
            expect(rangeByAnchor(ordered, 'missing', 't3')).toEqual(new Set(['t3']));
        });

        test('目标不在列表中时返回空集', () => {
            const ordered = ['t1', 't2', 't3'];
            expect(rangeByAnchor(ordered, 't1', 'missing')).toEqual(new Set());
        });
    });

    describe('shouldStartMarquee', () => {
        test('选区覆盖不足两个任务时不进入多选（防误操作）', () => {
            expect(shouldStartMarquee(0)).toBe(false);
            expect(shouldStartMarquee(1)).toBe(false);
        });

        test('覆盖两个及以上任务时进入多选', () => {
            expect(shouldStartMarquee(2)).toBe(true);
            expect(shouldStartMarquee(5)).toBe(true);
        });

        test('门槛常量为 2', () => {
            expect(MIN_MARQUEE_SELECTION).toBe(2);
        });
    });

    describe('鼠标框选交互', () => {
        // 鼠标路径的真实几何契约：mousedown→mousemove→mouseup 的命中计算、
        // 门槛吞合成 click、可编辑元素排除、激活时退重命名、双层滚动容器的自动滚动。
        // linkedom 没有 requestAnimationFrame：用 setTimeout 驱动自动滚动帧。
        // 注意 stable-timer-environment 只守护 Node 定时器名，fake→real 循环的
        // uninstall 可能删掉这里的 rAF stub（goal.test.ts 同款坑），故每个用例
        // 进 setup 时重查补装，而不是只在 beforeAll 装一次。
        const g = globalThis as any;
        const installRafStub = () => {
            if (typeof g.requestAnimationFrame !== 'function') {
                g.requestAnimationFrame = (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0);
            }
            if (typeof g.cancelAnimationFrame !== 'function') {
                g.cancelAnimationFrame = (id: any) => clearTimeout(id);
            }
        };

        async function setupMouseHarness(multi: boolean, rowCount = 4) {
            installRafStub();
            const { parseHTML } = await import('linkedom');
            const { window } = parseHTML('<!doctype html><html><body></body></html>');
            const { attachSidebarMultiSelect } = await import('../../../renderer/sidebarMultiSelectController.js');
            const { createMarqueeHarness } = await import('./sidebar-marquee-harness.js');
            const state = { multi };
            const rows = Array.from({ length: rowCount }, (_, index) => ({ id: `t${index + 1}`, top: index * 20 }));
            const harness = createMarqueeHarness(rows, window as any);
            const controller = attachSidebarMultiSelect(harness.container as any, {
                rowSelector: '.row',
                groupsSelector: '.groups',
                isMultiSelect: () => state.multi,
                setMultiSelect: (on: boolean) => {
                    state.multi = on;
                },
                getSelection: () => harness.selection,
                setSelection: (ids: Set<string>) => {
                    harness.selection = ids;
                }
            });
            return { harness, controller, state };
        }

        test('拖动覆盖两个任务后松手进入多选并选中命中的行', async () => {
            const { harness, controller, state } = await setupMouseHarness(false, 4);

            const row1 = harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement;
            harness.mouseDown(row1, 100, 25);
            harness.mouseMove(100, 60);
            harness.mouseUp(100, 60);

            expect(state.multi).toBe(true);
            expect(harness.selection).toEqual(new Set(['t1', 't2']));
            controller.destroy();
        });

        test('覆盖不足两个任务时不进入多选', async () => {
            const { harness, controller, state } = await setupMouseHarness(false, 4);

            const row1 = harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement;
            harness.mouseDown(row1, 100, 25);
            harness.mouseMove(101, 30);
            harness.mouseUp(101, 30);

            expect(state.multi).toBe(false);
            expect(harness.selection.size).toBe(0);
            controller.destroy();
        });

        test('自动滚动后松手：已滚出选区的扫过行保留选中（累积语义）', async () => {
            jest.useFakeTimers();
            try {
                const { harness, controller, state } = await setupMouseHarness(false, 4);
                const row1 = harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement;
                // 从 t1（20..38）按下，向下拖过 t2..t4 到内层 body 下边缘（166..190）触发自动滚动
                harness.mouseDown(row1, 100, 25);
                harness.mouseMove(100, 185);
                await jest.advanceTimersByTimeAsync(30);
                // 滚动 8px/帧把行推出固定选区上方；松手时若按「松手时刻几何相交」判定会丢失
                harness.mouseUp(100, 185);

                expect(state.multi).toBe(true);
                // t1..t4 全部被扫过：即使自动滚动后已移出选区，也不丢
                expect(harness.selection).toEqual(new Set(['t1', 't2', 't3', 't4']));
                controller.destroy();
            } finally {
                jest.useRealTimers();
            }
        });

        test('从可编辑元素上启动的拖动不进入框选（重命名输入框选词）', async () => {
            const { harness, controller, state } = await setupMouseHarness(false, 4);
            const input = harness.document.createElement('input');
            input.type = 'text';
            (harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement).appendChild(input);

            harness.mouseDown(input, 100, 25);
            harness.mouseMove(60, 80);
            harness.mouseUp(60, 80);

            expect(state.multi).toBe(false);
            expect(harness.selection.size).toBe(0);
            controller.destroy();
        });

        test('框选拖动激活时退出行内重命名（blur 输入框）', async () => {
            const { harness, controller, state } = await setupMouseHarness(false, 4);
            const row1 = harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement;
            const input = harness.document.createElement('input');
            input.type = 'text';
            row1.appendChild(input);
            row1.appendChild(harness.document.createElement('input'));
            const input2 = row1.querySelectorAll('input')[1];
            input2.focus();

            harness.mouseDown(input2, 100, 25);
            harness.mouseMove(60, 80);

            expect(harness.document.activeElement).not.toBe(input2);
            controller.destroy();
        });

        test('光标拖到列表下边缘时自动滚动展开分组的内层滚动容器', async () => {
            jest.useFakeTimers();
            try {
                const { harness, controller, state } = await setupMouseHarness(false, 4);
                const row1 = harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement;
                harness.mouseDown(row1, 100, 100);
                harness.mouseMove(100, 195);
                await jest.advanceTimersByTimeAsync(50);

                // 光标（y=195）在 .group-body（20..190）之外、外层 .groups（0..200）之内：
                // 内层已到视觉边界，自动滚动应作用在外层容器上
                expect(harness.outerScrollTop).toBeGreaterThan(0);
                expect(state.multi).toBe(false);
                controller.destroy();
            } finally {
                jest.useRealTimers();
            }
        });

        test('光标拖进展开分组内部时自动滚动内层 body 而不是外层', async () => {
            jest.useFakeTimers();
            try {
                const { harness, controller, state } = await setupMouseHarness(false, 4);
                const row1 = harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement;
                harness.mouseDown(row1, 100, 100);
                // 光标落在内层 body（20..190）内且接近其下边缘 → 滚内层
                harness.mouseMove(100, 185);
                await jest.advanceTimersByTimeAsync(50);

                expect(harness.innerScrollTop).toBeGreaterThan(0);
                expect(harness.outerScrollTop).toBe(0);
                expect(state.multi).toBe(false);
                controller.destroy();
            } finally {
                jest.useRealTimers();
            }
        });

        test('框选中列表被重建后，新行节点恢复 hover 高亮与选中态', async () => {
            const { harness, controller, state } = await setupMouseHarness(false, 4);
            const row1 = harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement;
            harness.mouseDown(row1, 100, 25);
            harness.mouseMove(100, 60);
            // 模拟重命名确认/订阅刷新触发 reloadTaskList：行节点 innerHTML 重建
            harness.rebuild();
            const newRow1 = harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement;
            expect(newRow1).not.toBe(row1);

            // 拖动继续：新节点应获得 hover 高亮，而不是 toggle 在游离的旧节点上
            harness.mouseMove(100, 61);
            expect(newRow1.classList.contains('is-marquee-hover')).toBe(true);
            // 松手后所有行（含游离的旧节点）都被清掉 hover
            expect(row1.classList.contains('is-marquee-hover')).toBe(true);
            harness.mouseUp(100, 61);
            expect(row1.classList.contains('is-marquee-hover')).toBe(false);
            expect(newRow1.classList.contains('is-marquee-hover')).toBe(false);

            // 松手进入多选后，新行节点的选中样式由 syncAfterRender 维护
            expect(state.multi).toBe(true);
            controller.destroy();
        });

        test('框选松手后吞掉补发的合成 click（不立刻打开任务）', async () => {
            const { harness, controller, state } = await setupMouseHarness(false, 4);
            const row1 = harness.container.querySelector('.row[data-task_id="t1"]') as HTMLElement;
            harness.mouseDown(row1, 100, 25);
            harness.mouseMove(100, 60);
            harness.mouseUp(100, 60);

            // 松手后立刻补发合成 click（无装饰键）：应被 150ms 窗口吞掉，不退出多选
            const clickEvent = new (harness.document.defaultView as any).Event('click', {
                bubbles: true,
                cancelable: true
            });
            row1.dispatchEvent(clickEvent);

            expect(state.multi).toBe(true);
            expect(harness.selection.size).toBe(2);
            controller.destroy();
        });
    });

    describe('触摸设备交互契约', () => {
        // linkedom 无全局 document，且 controller 的 document 级监听绑定在
        // ownerDocument 上，这里用 parseHTML 自建隔离实例直连真实控制器。
        async function setupTouchHarness(multi: boolean, rowCount = 3) {
            const { parseHTML } = await import('linkedom');
            const { window } = parseHTML('<!doctype html><html><body></body></html>');
            const { attachSidebarMultiSelect } = await import('../../../renderer/sidebarMultiSelectController.js');
            const { createMarqueeHarness } = await import('./sidebar-marquee-harness.js');
            const state = { multi };
            const rows = Array.from({ length: rowCount }, (_, index) => ({ id: `t${index + 1}`, top: index * 20 }));
            const harness = createMarqueeHarness(rows, window as any);
            const controller = attachSidebarMultiSelect(harness.container as any, {
                rowSelector: '.row',
                groupsSelector: '.groups',
                isMultiSelect: () => state.multi,
                setMultiSelect: (on: boolean) => {
                    state.multi = on;
                },
                getSelection: () => harness.selection,
                setSelection: (ids: Set<string>) => {
                    harness.selection = ids;
                }
            });
            return { harness, controller, state };
        }

        test('常规态触摸拖动是列表滚动：不进入框选、不 preventDefault', async () => {
            const { harness, controller, state } = await setupTouchHarness(false, 2);

            harness.touchStart('t1', 10, 10);
            harness.document.dispatchEvent(harness.touchMove(10, 60));
            harness.document.dispatchEvent(harness.touchEnd(7));

            expect(state.multi).toBe(false);
            expect(harness.selection.size).toBe(0);
            expect(harness.preventedDefaults).toBe(0);
            controller.destroy();
        });

        test('多选态触摸操作退出多选且吞掉后续事件', async () => {
            const { harness, controller, state } = await setupTouchHarness(true, 3);
            harness.selection = new Set(['t1', 't2']);

            const event = harness.touchStart('t3', 10, 10);

            expect(state.multi).toBe(false);
            expect(event.defaultPrevented).toBe(true);
            controller.destroy();
        });

        test('常规态触摸拖动后不残留框选状态（选区盒已被移除）', async () => {
            const { harness, controller, state } = await setupTouchHarness(false, 2);

            harness.touchStart('t1', 10, 10);
            harness.document.dispatchEvent(harness.touchMove(10, 60));
            harness.document.dispatchEvent(harness.touchEnd(7));

            expect(state.multi).toBe(false);
            expect(harness.document.querySelector('.sb-marquee-box')).toBeNull();
            controller.destroy();
        });
    });
});
