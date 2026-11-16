// 侧边栏任务多选 DOM 集成测试：在 linkedom 环境下验证
// 右键菜单入口、多选形态渲染、独立右键菜单与退出逻辑。
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const showConfirmModal = jest.fn(async () => true);

describe('sidebar multi-select', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0),
            MutationObserver: class {
                observe() {}
                disconnect() {}
            },
            ResizeObserver: class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
            localStorage: {
                getItem: () => null,
                setItem: () => undefined,
                removeItem: () => undefined
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            writable: true,
            value: { language: 'zh-CN', languages: ['zh-CN'] }
        });
        window.applicationRegistryAPI = {
            getApplicationList: async () => [],
            call: async () => undefined,
            callMainWorld: async () => undefined,
            subscribeEvent: async () => () => undefined
        } as any;
        window.taskManagerAPI = {
            getTaskList: async () => [],
            subscribeTaskListUpdate: jest.fn(async () => () => undefined),
            getTaskInfo: async () => ({}),
            removeTask: jest.fn(async () => [])
        } as any;
        window.globalControlAPI = {
            openTask: jest.fn(() => undefined),
            openHomePage: () => undefined,
            removeTaskViewCache: () => undefined,
            clearAllTaskViewCache: () => undefined
        } as any;
        await jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () => ({
            escapeModalText: (text: string) => text,
            showConfirmModal,
            bindOverlayDismiss: () => undefined,
            MODAL_CSS: '',
            renderIcon: () => '',
            CLOSE_SVG: '',
            detectDarkMode: () => false,
            MODAL_ANIM_DURATION_OUT: 0
        }));
        await import('../../../renderer/components/sidebar.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        document.documentElement.dataset.theme = 'light';
        (window.globalControlAPI.openTask as any).mockClear?.();
        (window.taskManagerAPI.removeTask as any).mockClear?.();
    });

    function createSidebar() {
        const sidebar = document.createElement('main-sidebar');
        document.body.appendChild(sidebar);
        return sidebar as any;
    }

    test('常规右键菜单含「选择多个任务」与「删除当前分类全部任务」', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [{ task_id: 'task_1', task_name: 'T1', created_at: Date.now(), updated_at: Date.now() }];
        sidebar._showContextMenu(100, 100, 'task_1');

        const menu = document.querySelector('#task-context-menu') as HTMLElement;
        expect(menu).not.toBeNull();
        const actions = Array.from(menu.querySelectorAll('[data-action]')).map((el) => el.getAttribute('data-action'));
        expect(actions).toContain('multi-select');
        // 删除任务与删除全部任务之间必须存在删除当前分类项
        expect(actions.indexOf('delete-group')).toBeGreaterThan(actions.indexOf('delete'));
        expect(actions.indexOf('delete-group')).toBeLessThan(actions.indexOf('delete-all'));
    });

    test('时间视图下分组删除项文案为「删除近7天的任务」这类形式', () => {
        const sidebar = createSidebar();
        // 构造一个活动时间在 3 天前的任务 → this-week（近7天）分组
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        sidebar.taskList = [{ task_id: 'task_w', task_name: 'W', created_at: threeDaysAgo, updated_at: threeDaysAgo }];
        sidebar._showContextMenu(100, 100, 'task_w');
        const menu = document.querySelector('#task-context-menu') as HTMLElement;
        const label = menu.querySelector('[data-action="delete-group"] .ctx-label') as HTMLElement;
        expect(label.textContent).toContain('近7天');
    });

    test('进入多选后行内状态图标替换为圆形选择框，选中态有 is-checked', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', task_status: 'success', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', task_status: 'failed', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect();
        expect(sidebar._multiSelect).toBe(true);

        const rows = sidebar.querySelectorAll('.task-item.sb-task-row');
        expect(rows.length).toBe(2);
        for (const row of rows) {
            expect(row.querySelector('.sb-running-spinner')).toBeNull();
            expect(row.querySelector('.sb-task-result')).toBeNull();
            expect(row.querySelector('.sb-multi-checkbox')).not.toBeNull();
        }
        // 预选 a 后重渲染，a 的圆形选择框带 is-checked
        sidebar._enterMultiSelect(new Set(['a']));
        const rowA = sidebar.querySelector('.task-item[data-task_id="a"]') as HTMLElement;
        expect(rowA.querySelector('.sb-multi-checkbox').classList.contains('is-checked')).toBe(true);
        const rowB = sidebar.querySelector('.task-item[data-task_id="b"]') as HTMLElement;
        expect(rowB.querySelector('.sb-multi-checkbox').classList.contains('is-checked')).toBe(false);
    });

    test('多选态右键弹独立菜单，仅含「删除 N 个已选任务」', async () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect(new Set(['a', 'b']));
        sidebar._showMultiSelectContextMenu(50, 50);

        const menu = document.querySelector('#task-multi-select-menu') as HTMLElement;
        expect(menu).not.toBeNull();
        const items = Array.from(menu.querySelectorAll('[data-action]'));
        expect(items.length).toBe(1);
        expect(items[0].getAttribute('data-action')).toBe('delete-selected');
        expect(items[0].textContent).toContain('2');
        // 常规菜单不应同时出现
        expect(document.querySelector('#task-context-menu')).toBeNull();
    });

    test('Ctrl 点选 toggle 选中集合，Shift 区间选覆盖锚点到目标', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 't1', task_name: '1', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 't2', task_name: '2', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 't3', task_name: '3', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect();
        sidebar.reloadTaskList();

        sidebar._handleMultiSelectRowClick({ ctrlKey: true, shiftKey: false, stopPropagation: () => {} }, 't1');
        expect(sidebar._multiSelectIds).toEqual(new Set(['t1']));
        sidebar._handleMultiSelectRowClick({ ctrlKey: true, shiftKey: false, stopPropagation: () => {} }, 't1');
        expect(sidebar._multiSelectIds).toEqual(new Set());

        sidebar._handleMultiSelectRowClick({ ctrlKey: false, shiftKey: false, stopPropagation: () => {} }, 't1');
        sidebar._handleMultiSelectRowClick(
            { ctrlKey: false, metaKey: false, shiftKey: true, stopPropagation: () => {} },
            't3'
        );
        expect(sidebar._multiSelectIds).toEqual(new Set(['t1', 't2', 't3']));
    });

    test('多选态下点击行是 toggle 加选，不清空其它已选行', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'c', task_name: 'C', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect(new Set(['a']));

        const rowB = sidebar.querySelector('.task-item[data-task_id="b"]') as HTMLElement;
        rowB.dispatchEvent(new (window as any).Event('click', { bubbles: true }));
        expect(sidebar._multiSelectIds).toEqual(new Set(['a', 'b']));

        // 再点一次 b 取消，a 仍在（不能变成「只选 a」或「清空」）
        rowB.dispatchEvent(new (window as any).Event('click', { bubbles: true }));
        expect(sidebar._multiSelectIds).toEqual(new Set(['a']));

        // 点未选中的 c 也是加选，多选形态保持不变
        const rowC = sidebar.querySelector('.task-item[data-task_id="c"]') as HTMLElement;
        rowC.dispatchEvent(new (window as any).Event('click', { bubbles: true }));
        expect(sidebar._multiSelectIds).toEqual(new Set(['a', 'c']));
        expect(sidebar._multiSelect).toBe(true);
    });

    test('触屏轻点列表内的行不退出多选，列表外触摸才退出', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect(new Set(['a']));

        const rowB = sidebar.querySelector('.task-item[data-task_id="b"]') as HTMLElement;
        rowB.dispatchEvent(new (window as any).Event('touchstart', { bubbles: true }));
        expect(sidebar._multiSelect).toBe(true);
        // 轻点照常生成合成 click → toggle 加选
        rowB.dispatchEvent(new (window as any).Event('click', { bubbles: true }));
        expect(sidebar._multiSelectIds).toEqual(new Set(['a', 'b']));
        expect(sidebar._multiSelect).toBe(true);

        // 列表外的触屏（如侧边栏头部）退出多选
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        outside.dispatchEvent(new (window as any).Event('touchstart', { bubbles: true }));
        expect(sidebar._multiSelect).toBe(false);
    });

    test('Esc 退出多选并恢复常规渲染', async () => {
        const sidebar = createSidebar();
        sidebar.taskList = [{ task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() }];
        sidebar._enterMultiSelect(new Set(['a']));
        expect(sidebar._multiSelect).toBe(true);

        const escEvent: any = new (window as any).Event('keydown');
        escEvent.key = 'Escape';
        document.dispatchEvent(escEvent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(sidebar._multiSelect).toBe(false);
        // connectedCallback 里 getTaskList 的异步回调会把 taskList 覆盖为 []，重新赋值再验证渲染
        sidebar.taskList = [{ task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() }];
        sidebar.reloadTaskList();
        const row = sidebar.querySelector('.task-item[data-task_id="a"]') as HTMLElement;
        expect(row).not.toBeNull();
        expect(row.querySelector('.sb-multi-checkbox')).toBeNull();
    });

    test('多选态点击运行区卡片不进入选择集合，普通点击打开任务', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'run1', task_name: 'R', task_status: 'running', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect();
        expect(sidebar._multiSelect).toBe(true);

        const runningHeader = sidebar.querySelector('.sb-running-header') as HTMLElement;
        expect(runningHeader).not.toBeNull();
        const clickEvent: any = new (window as any).Event('click', { bubbles: true });
        runningHeader.dispatchEvent(clickEvent);

        expect(sidebar._multiSelectIds.size).toBe(0);
        // 运行区卡片在多选态保留原有语义：打开任务
        expect(window.globalControlAPI.openTask).toHaveBeenCalledWith('run1');
    });

    test('多选批量删除过滤收藏任务并在全部被滤除时不弹确认', async () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'fav', task_name: 'F', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'plain', task_name: 'P', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._favoritedTaskIds = new Set(['fav']);
        sidebar._enterMultiSelect(new Set(['fav', 'plain']));
        showConfirmModal.mockClear();

        const confirmed = await sidebar._confirmAndDeleteTasks(['fav', 'plain']);

        expect(confirmed).toBe(true);
        expect(showConfirmModal).toHaveBeenCalledTimes(1);
        // 确认弹窗数量 = 过滤后的待删数，收藏任务不被删除
        const call = showConfirmModal.mock.calls[0][0];
        expect(call.message).toContain('1');
        expect(window.taskManagerAPI.removeTask).not.toHaveBeenCalledWith('fav');
        expect(window.taskManagerAPI.removeTask).toHaveBeenCalledWith('plain');
    });

    test('多选删除路径全部命中收藏任务时不弹确认直接跳过', async () => {
        const sidebar = createSidebar();
        sidebar.taskList = [{ task_id: 'fav', task_name: 'F', created_at: Date.now(), updated_at: Date.now() }];
        sidebar._favoritedTaskIds = new Set(['fav']);
        sidebar._enterMultiSelect(new Set(['fav']));
        showConfirmModal.mockClear();

        const confirmed = await sidebar._confirmAndDeleteTasks(['fav']);

        expect(confirmed).toBe(false);
        expect(showConfirmModal).not.toHaveBeenCalled();
        expect(window.taskManagerAPI.removeTask).not.toHaveBeenCalled();
    });

    test('批量删除包含当前打开任务时先回主页再开始删除（三个批量路径口径一致）', async () => {
        // 多选批量删除
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'cur', task_name: 'C', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'plain', task_name: 'P', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar.currentTaskId = 'cur';
        sidebar._updateTaskHighlight = jest.fn();
        sidebar._enterMultiSelect(new Set(['cur', 'plain']));
        showConfirmModal.mockClear();

        await sidebar._confirmAndDeleteTasks(['cur', 'plain']);

        const homeIndex = (window.globalControlAPI.openTask as any).mock.invocationCallOrder[0];
        const removeIndex = (window.taskManagerAPI.removeTask as any).mock.invocationCallOrder[0];
        expect(window.globalControlAPI.openTask).toHaveBeenCalledWith(null);
        // 先回主页，再执行第一个删除
        expect(homeIndex).toBeLessThan(removeIndex);

        // 分组删除同样先回主页（清 mock 后独立断言，避免 invocationCallOrder 跨用例累计错位）
        (window.globalControlAPI.openTask as any).mockClear();
        (window.taskManagerAPI.removeTask as any).mockClear();
        const sidebar2 = createSidebar();
        sidebar2.taskList = [
            { task_id: 'g1', task_name: 'G1', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'g2', task_name: 'G2', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar2.currentTaskId = 'g1';
        sidebar2._updateTaskHighlight = jest.fn();
        const group = sidebar2._findGroupByTaskId('g1');
        await sidebar2._deleteTasksInGroup(group);
        const homeIndex2 = (window.globalControlAPI.openTask as any).mock.invocationCallOrder[0];
        const removeIndex2 = (window.taskManagerAPI.removeTask as any).mock.invocationCallOrder[0];
        expect(homeIndex2).toBeLessThan(removeIndex2);
    });

    test('切换时间/工作空间视图与收藏夹时退出多选', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', workspace: '/ws', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._taskView = 'workspace';
        sidebar.reloadTaskList();
        sidebar._enterMultiSelect(new Set(['a']));
        expect(sidebar._multiSelect).toBe(true);

        const viewButton = sidebar.querySelector('[data-task-view="time"]') as HTMLElement;
        viewButton.dispatchEvent(new (window as any).Event('click', { bubbles: true }));
        expect(sidebar._multiSelect).toBe(false);

        // 收藏夹切换同样退出
        sidebar._enterMultiSelect(new Set(['a']));
        const favToggle = sidebar.querySelector('[data-favorites-toggle]') as HTMLElement;
        favToggle.dispatchEvent(new (window as any).Event('click', { bubbles: true }));
        expect(sidebar._multiSelect).toBe(false);
    });

    test('侧边栏断开连接时清理多选菜单的 document dismiss 监听', async () => {
        const sidebar = createSidebar();
        sidebar.taskList = [{ task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() }];
        sidebar._enterMultiSelect(new Set(['a']));
        sidebar._showMultiSelectContextMenu(50, 50);
        expect(sidebar._multiSelectMenuDismissHandler).not.toBeNull();

        sidebar.disconnectedCallback();
        expect(sidebar._multiSelectMenuDismissHandler).toBeNull();

        // 断开后菜单外点击不再触发任何处理器（无异常即通过）
        document.body.dispatchEvent(new (window as any).Event('click', { bubbles: true }));
    });

    test('菜单打开后立即关闭：延迟注册回调不得把 null 监听写进 document', async () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect(new Set(['a', 'b']));
        sidebar._showMultiSelectContextMenu(50, 50);
        // 0ms 内关闭菜单，_multiSelectMenuDismissHandler 置 null；
        // 延迟注册回调若不校验会把 null 挂到 document，污染后续所有 click 冒泡
        sidebar._dismissMultiSelectMenu();
        expect(sidebar._multiSelectMenuDismissHandler).toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 10));
        // 冒泡到 document 的 click 不应因坏监听抛错
        expect(() => document.body.dispatchEvent(new (window as any).Event('click', { bubbles: true }))).not.toThrow();
    });

    test('多选菜单与常规右键菜单互斥，不叠加显示', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect(new Set(['a', 'b']));
        sidebar._showMultiSelectContextMenu(50, 50);
        expect(document.querySelector('#task-multi-select-menu')).not.toBeNull();

        // 常规菜单打开时多选菜单应被收起
        sidebar._showContextMenu(60, 60, 'a');
        expect(document.querySelector('#task-multi-select-menu')).toBeNull();
        expect(document.querySelector('#task-context-menu')).not.toBeNull();

        // 反向：多选菜单打开时常规菜单应被收起
        sidebar._showMultiSelectContextMenu(70, 70);
        expect(document.querySelector('#task-context-menu')).toBeNull();
        expect(document.querySelector('#task-multi-select-menu')).not.toBeNull();
    });

    test('外部任务刷新剔除已消失的选中 id，计数不失真', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect(new Set(['a', 'b']));

        // 外部刷新：任务 b 已被其他入口删除（取本用例 sidebar 的订阅回调）
        const calls = (window.taskManagerAPI.subscribeTaskListUpdate as any).mock.calls;
        const subscriber = calls[calls.length - 1][0];
        subscriber([{ task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() }]);

        expect(sidebar._multiSelectIds).toEqual(new Set(['a']));
    });

    test('确认弹窗打开期间 Esc 不退出多选', async () => {
        const sidebar = createSidebar();
        sidebar.taskList = [{ task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() }];
        sidebar._enterMultiSelect(new Set(['a']));

        // 模拟确认弹窗遮罩挂在 body
        const overlay = document.createElement('div');
        overlay.className = 'od-confirm-modal-overlay';
        document.body.appendChild(overlay);

        const escEvent: any = new (window as any).Event('keydown');
        escEvent.key = 'Escape';
        document.dispatchEvent(escEvent);
        expect(sidebar._multiSelect).toBe(true);

        overlay.remove();
        document.dispatchEvent(escEvent);
        expect(sidebar._multiSelect).toBe(false);
    });

    test('原生 modal dialog（任务搜索弹窗）打开期间 Esc 不退出多选', () => {
        const sidebar = createSidebar();
        sidebar.taskList = [{ task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() }];
        sidebar._enterMultiSelect(new Set(['a']));

        // 模拟任务搜索弹窗：原生 <dialog>.showModal()。linkedom 无 showModal 实现，
        // 直接置 open 属性——控制器只需探测「文档里有打开的原生 dialog」
        const dialog = document.createElement('dialog');
        dialog.setAttribute('open', '');
        document.body.appendChild(dialog);

        const escEvent: any = new (window as any).Event('keydown');
        escEvent.key = 'Escape';
        document.dispatchEvent(escEvent);
        // dialog 内部自管 Esc（cancel → hide），多选不应被连带退出
        expect(sidebar._multiSelect).toBe(true);

        dialog.removeAttribute('open');
        dialog.remove();
        document.dispatchEvent(escEvent);
        expect(sidebar._multiSelect).toBe(false);
    });

    test('经右键菜单进入多选保留既有选区（端到端 action 路径）', async () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect(new Set(['a']));

        // 模拟运行区卡片在多选态走常规菜单 → 点「选择多个任务」
        sidebar._showContextMenu(60, 60, 'a');
        const menu = document.querySelector('#task-context-menu') as HTMLElement;
        const action = menu.querySelector('[data-action="multi-select"]') as HTMLElement;
        action.dispatchEvent(new (window as any).Event('click', { bubbles: true }));

        expect(sidebar._multiSelect).toBe(true);
        expect(sidebar._multiSelectIds).toEqual(new Set(['a']));
    });

    test('多选态分组删除完成后退出多选', async () => {
        const sidebar = createSidebar();
        sidebar.taskList = [
            { task_id: 'a', task_name: 'A', created_at: Date.now(), updated_at: Date.now() },
            { task_id: 'b', task_name: 'B', created_at: Date.now(), updated_at: Date.now() }
        ];
        sidebar._enterMultiSelect(new Set(['a']));

        const group = sidebar._findGroupByTaskId('a');
        await sidebar._deleteTasksInGroup(group);

        expect(sidebar._multiSelect).toBe(false);
        expect(window.taskManagerAPI.removeTask).toHaveBeenCalledWith('a');
    });
});
