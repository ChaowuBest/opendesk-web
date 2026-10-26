// 回归：通过搜索等入口打开任务后，若任务所在分组处于折叠状态、位于列表深处或分页之外，
// 侧边栏应自动展开分组、按需扩充分页并将高亮任务滚动到可见区域（否则用户无法对任务做收藏/删除等操作）。
// 该能力统一收口在 _updateTaskHighlight(taskId, { revealCurrentTask: true })，
// 由 index.html 的 openTask() 统一触发。测试走真实渲染管线（reloadTaskList），不做 DOM 手搓。
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

// 固定时钟：分组判据是 activityAt >= 当天 0 点，用真实时钟在午夜前后运行时
// ts(i) 会跨越本地日期边界，today 组的任务被分到 this-week，分页断言随之失效。
const FIXED_NOW = new Date(2026, 6, 29, 12, 0, 0);
const earlierTaskId = 't-old-deep';

// 只冻结 Date，其余定时器保持真实实现，避免 flushRaf 依赖的 setTimeout 被挂起。
const REAL_TIMERS = [
    'clearImmediate',
    'clearInterval',
    'clearTimeout',
    'hrtime',
    'nextTick',
    'performance',
    'queueMicrotask',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'requestIdleCallback',
    'cancelIdleCallback',
    'setImmediate',
    'setInterval',
    'setTimeout'
] as const;

function ts(offsetMinutes: number): string {
    return new Date(FIXED_NOW.getTime() - offsetMinutes * 60_000).toISOString();
}

describe('sidebar reveal current task on highlight sync', () => {
    let scrollIntoViewSpy: ReturnType<typeof jest.fn>;
    let taskList: any[];
    let sidebar: any;

    beforeAll(async () => {
        jest.useFakeTimers({ now: FIXED_NOW, doNotFake: [...REAL_TIMERS] });
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
        // matches: true 让 _closeTaskGroup 走无动画的即时分支，方便断言手风琴切换
        (window as any).matchMedia = () => ({ matches: true });
        (window as any).applicationRegistryAPI = {
            getApplicationList: async () => [],
            call: async () => undefined,
            callMainWorld: async () => undefined,
            subscribeEvent: async () => () => undefined
        } as any;
        (window as any).taskManagerAPI = {
            // 永不 resolve：屏蔽 connectedCallback 的异步初始加载链，
            // 避免其延迟 reload 与测试的同步渲染管线竞态（生产环境中打开任务时初始化早已完成）
            getTaskList: () => new Promise(() => {}),
            subscribeTaskListUpdate: async () => () => undefined,
            getTaskInfo: async () => ({})
        } as any;
        await import('../../../renderer/components/sidebar.js');
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        document.documentElement.dataset.theme = 'light';
        scrollIntoViewSpy = jest.fn();
        (window.HTMLElement.prototype as any).scrollIntoView = scrollIntoViewSpy;
        // today 组 40 条真实任务（首页 30 条满页），另有 1 条 30 天前的任务落在 earlier 组
        taskList = Array.from({ length: 40 }, (_, i) => ({
            task_id: `t-today-${String(i).padStart(2, '0')}`,
            task_name: `今天的任务 ${i}`,
            task_status: 'completed',
            updated_at: ts(i)
        }));
        taskList.push({
            task_id: earlierTaskId,
            task_name: '很久之前的任务',
            task_status: 'completed',
            updated_at: ts(60 * 24 * 30)
        });
    });

    function createSidebar(): any {
        sidebar = document.createElement('main-sidebar');
        document.body.appendChild(sidebar);
        return sidebar;
    }

    function setupFullList(): void {
        createSidebar();
        // 真实环境中 taskList 由 subscribeTaskListUpdate 回调写入，测试里直接同步
        sidebar.taskList = taskList;
        sidebar.reloadTaskList();
        // linkedom 不反射 <details open> 到 .open 属性，手工同步一次
        sidebar.querySelectorAll('.sb-task-group[open]').forEach((details: any) => {
            details.open = true;
        });
    }

    function flushRaf(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 5));
    }

    test('打开主页（taskId 为 null）时直接返回', () => {
        setupFullList();
        expect(sidebar._updateTaskHighlight(null, { revealCurrentTask: true })).toBe(false);
        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });

    test('折叠分组中的当前任务被展开并滚动到可见（真实渲染管线）', () => {
        setupFullList();
        // 初始：today 组展开（第一个非空组），earlier 组折叠且任务行已在 DOM 中
        expect(sidebar.querySelector('.sb-task-group[data-group-id="earlier"]').hasAttribute('open')).toBe(false);
        expect(sidebar.querySelector(`.sb-task-row[data-task_id="${earlierTaskId}"]`)).not.toBeNull();

        const ok = sidebar._updateTaskHighlight(earlierTaskId, { revealCurrentTask: true });
        expect(ok).toBe(true);

        const target = sidebar.querySelector('.sb-task-group[data-group-id="earlier"]');
        expect(target.hasAttribute('open')).toBe(true);
        expect(sidebar._openTaskGroupId).toBe('earlier');
        expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' });
    });

    test('分页之外的任务：扩页 + 展开组 + 重渲染后滚动', async () => {
        // earlier 组 35 条真实任务，目标任务按活跃时间排第 35 位（30 条/页之外）
        taskList = Array.from({ length: 35 }, (_, i) => ({
            task_id: `t-old-${String(i).padStart(2, '0')}`,
            task_name: `旧任务 ${i}`,
            task_status: 'completed',
            updated_at: ts(60 * 24 * 30 - i)
        }));
        setupFullList();
        expect(sidebar.querySelector('.sb-task-row[data-task_id="t-old-00"]')).toBeNull();

        const ok = sidebar._updateTaskHighlight('t-old-00', { revealCurrentTask: true });
        expect(ok).toBe(true);
        expect(sidebar._groupDisplayLimits.get('earlier')).toBe(60);

        await flushRaf();
        expect(sidebar.querySelector('.sb-task-row[data-task_id="t-old-00"]')).not.toBeNull();
        expect(sidebar.querySelector('.sb-task-group[data-group-id="earlier"]').hasAttribute('open')).toBe(true);
        expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' });
    });

    test('可视区内的高亮任务不触发额外滚动开销（扩页路径不触发）', () => {
        setupFullList();
        // 首条任务在 DOM 且任务行未变，reveal 只做一次滚动调用（block:'nearest' 对可见元素无操作）
        const ok = sidebar._updateTaskHighlight('t-today-00', { revealCurrentTask: true });
        expect(ok).toBe(true);
        expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
        expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' });
    });

    test('可视区外（列表深处且分页之外）的高亮任务扩页后滚动到可见', async () => {
        setupFullList();
        // t-today-35 在 today 组第 36 位，首页未渲染
        expect(sidebar.querySelector('.sb-task-row[data-task_id="t-today-35"]')).toBeNull();

        const ok = sidebar._updateTaskHighlight('t-today-35', { revealCurrentTask: true });
        expect(ok).toBe(true);
        expect(sidebar._groupDisplayLimits.get('today')).toBe(60);

        await flushRaf();
        expect(sidebar.querySelector('.sb-task-row[data-task_id="t-today-35"]')).not.toBeNull();
        expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' });
    });

    test('未指定 reveal 选项时保持纯高亮语义，不展开不滚动', () => {
        setupFullList();
        const ok = sidebar._updateTaskHighlight(earlierTaskId);
        expect(ok).toBeUndefined();
        expect(sidebar.querySelector('.sb-task-group[data-group-id="earlier"]').hasAttribute('open')).toBe(false);
        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
        expect(
            sidebar.querySelector(`.sb-task-row[data-task_id="${earlierTaskId}"]`).classList.contains('is-current')
        ).toBe(true);
    });

    test('收起态侧边栏（无任务列表容器）时返回 false', () => {
        createSidebar();
        sidebar.innerHTML = '<div class="sb-rail"></div>';
        expect(sidebar._updateTaskHighlight('t1', { revealCurrentTask: true })).toBe(false);
        expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    });

    test('运行区中的当前任务滚动其运行卡片到可见', () => {
        taskList.unshift({
            task_id: 't-running',
            task_name: '运行中的任务',
            task_status: 'running',
            updated_at: ts(0)
        });
        setupFullList();
        expect(sidebar.querySelector('.sb-running-header[data-task_id="t-running"]')).not.toBeNull();
        const ok = sidebar._updateTaskHighlight('t-running', { revealCurrentTask: true });
        expect(ok).toBe(true);
        expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'nearest' });
    });
});
