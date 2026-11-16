import { beforeAll, beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 侧边栏「任务信息」弹窗测试：
 * - 深浅色模式跟随（od-modal-dark）
 * - 顶部色带结构（info 变体）与字段行渲染
 * - 用户可控内容转义
 * - 字体与配色 token 化（不再硬编码浅色样式）
 * - 关闭后移除 DOM
 */
describe('sidebar task info modal', () => {
    let clipboardWriteText: ReturnType<typeof jest.fn>;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        clipboardWriteText = jest.fn<() => Promise<void>>();
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
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
            value: {
                language: 'zh-CN',
                languages: ['zh-CN'],
                clipboard: { writeText: clipboardWriteText }
            }
        });
        window.applicationRegistryAPI = {
            getApplicationList: async () => [],
            call: async () => undefined,
            callMainWorld: async () => undefined,
            subscribeEvent: async () => () => undefined
        };
        window.taskManagerAPI = {
            getTaskList: async () => [],
            subscribeTaskListUpdate: async () => () => undefined,
            getTaskInfo: async () => ({})
        } as any;
        await import('../../../renderer/components/sidebar.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        document.documentElement.dataset.theme = 'light';
        clipboardWriteText.mockReset();
        clipboardWriteText.mockResolvedValue(undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    function createSidebar() {
        const sidebar = document.createElement('main-sidebar');
        document.body.appendChild(sidebar);
        return sidebar as HTMLElement & { _showTaskInfoModal: (taskId: string) => void };
    }

    function mockTaskInfo(info: Record<string, unknown>) {
        (window as any).taskManagerAPI.getTaskInfo = jest.fn().mockResolvedValue(info);
    }

    async function flushMicrotasks() {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
    }

    test('深色模式下打开弹窗时挂载 od-modal-dark，浅色下不挂载', () => {
        const sidebar = createSidebar();
        mockTaskInfo({});

        document.documentElement.dataset.theme = 'dark';
        sidebar._showTaskInfoModal('task_dark');
        let overlay = document.querySelector('.od-taskinfo-overlay');
        expect(overlay).not.toBeNull();
        expect(overlay!.classList.contains('od-modal-dark')).toBe(true);
        overlay!.remove();

        document.documentElement.dataset.theme = 'light';
        sidebar._showTaskInfoModal('task_light');
        overlay = document.querySelector('.od-taskinfo-overlay');
        expect(overlay).not.toBeNull();
        expect(overlay!.classList.contains('od-modal-dark')).toBe(false);
    });

    test('采用顶部色带风格：info 色带 + 本地化标题 + 底部关闭按钮', async () => {
        const sidebar = createSidebar();
        mockTaskInfo({});
        sidebar._showTaskInfoModal('task_x');

        const overlay = document.querySelector('.od-taskinfo-overlay')!;
        expect(overlay.querySelector('.od-confirm-modal-banner.info')).not.toBeNull();
        expect(overlay.querySelector('.od-confirm-modal-title')!.textContent).toBe('任务信息');
        expect(overlay.querySelector('.od-confirm-modal-footer .od-confirm-btn-primary')!.textContent).toBe('关闭');
        // 色带图标为内联 SVG（fa-circle-info 渲染结果），不再依赖 <i> 标签
        expect(overlay.querySelector('.od-confirm-modal-icon svg')).not.toBeNull();
    });

    test('字段行渲染：五个基础字段 + 父任务 ID 插入在任务 ID 之后', async () => {
        const sidebar = createSidebar();
        mockTaskInfo({
            task_name: '修复导出',
            task_id: 'task_child',
            parent_id: 'task_parent',
            task_status: 'running',
            task_json_path: 'C:\\t\\task_child.json',
            model: 'glm-5.3-flash'
        });
        sidebar._showTaskInfoModal('task_child');
        await flushMicrotasks();

        const labels = Array.from(document.querySelectorAll('.od-taskinfo-label')).map((el) => el.textContent);
        expect(labels).toEqual(['任务名称', '任务 ID', '父任务 ID', '状态', '数据文件', '模型']);

        const values = Array.from(document.querySelectorAll('.od-taskinfo-value')).map((el) => el.textContent);
        expect(values).toEqual([
            '修复导出',
            'task_child',
            'task_parent',
            'running',
            'C:\\t\\task_child.json',
            'glm-5.3-flash'
        ]);
        // 每行都有复制按钮
        expect(document.querySelectorAll('.od-taskinfo-copy-btn').length).toBe(6);
    });

    test('任务名缺失显示未命名，模型缺失显示默认', async () => {
        const sidebar = createSidebar();
        mockTaskInfo({ task_name: null, task_id: 'task_1', task_status: 'done', task_json_path: 'p', model: '' });
        sidebar._showTaskInfoModal('task_1');
        await flushMicrotasks();

        const values = Array.from(document.querySelectorAll('.od-taskinfo-value')).map((el) => el.textContent);
        expect(values[0]).toBe('(未命名)');
        expect(values[4]).toBe('(默认)');
    });

    test('用户可控内容被转义，不注入 HTML', async () => {
        const sidebar = createSidebar();
        const hostile = '<img src=x onerror=alert(1)>';
        mockTaskInfo({ task_name: hostile, task_id: 'task_1', task_status: 'done', task_json_path: 'p', model: 'm' });
        sidebar._showTaskInfoModal('task_1');
        await flushMicrotasks();

        const rowsHtml = document.querySelector('.od-taskinfo-rows')!.innerHTML;
        // DOM 层面断言：恶意串只作为文本/属性值出现，没有实际注入 img 元素
        expect(document.querySelector('.od-taskinfo-rows img')).toBeNull();
        const nameValue = document.querySelectorAll('.od-taskinfo-value')[0];
        expect(nameValue!.textContent).toBe(hostile);
        // 复制按钮 data-copy 携带原始文本（实体转义后可安全放入双引号属性）
        const copyBtn = document.querySelector('.od-taskinfo-copy-btn') as HTMLElement & { dataset: { copy: string } };
        expect(copyBtn.dataset.copy).toBe(hostile);
    });

    test('复制成功后进入 copied 态，1500ms 后还原且连点不叠加定时器', async () => {
        // doNotFake setImmediate：flushMicrotasks 依赖它冲刷微任务，被 fake 会挂起。
        // 用 fake timers 让还原定时器不产生真实句柄，避免泄漏拖住 worker 退出宽限期
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        try {
            const sidebar = createSidebar();
            mockTaskInfo({ task_name: 'n', task_id: 'task_1', task_status: 'done', task_json_path: 'p', model: 'm' });
            sidebar._showTaskInfoModal('task_1');
            await flushMicrotasks();

            const btn = document.querySelector('.od-taskinfo-copy-btn') as HTMLElement;
            btn.click();
            await flushMicrotasks();

            expect(clipboardWriteText).toHaveBeenCalledWith('n');
            expect(btn.classList.contains('copied')).toBe(true);
            expect(btn.querySelector('i')!.className).toContain('fa-check');

            // 快速连点：先清掉上一次的还原定时器，只保留最后一个
            btn.click();
            await flushMicrotasks();
            expect(jest.getTimerCount()).toBe(1);

            jest.advanceTimersByTime(1500);
            expect(btn.classList.contains('copied')).toBe(false);
            expect(btn.querySelector('i')!.className).toContain('fa-copy');
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('复制后关闭弹窗时清理未触发的还原定时器', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        try {
            const sidebar = createSidebar();
            mockTaskInfo({ task_name: 'n', task_id: 'task_1', task_status: 'done', task_json_path: 'p', model: 'm' });
            sidebar._showTaskInfoModal('task_1');
            await flushMicrotasks();

            const btn = document.querySelector('.od-taskinfo-copy-btn') as HTMLElement;
            btn.click();
            await flushMicrotasks();
            expect(jest.getTimerCount()).toBe(1);

            const overlay = document.querySelector('.od-taskinfo-overlay') as HTMLElement;
            (overlay.querySelector('[data-action="close"]') as HTMLElement).click();
            // 关闭动画的 overlay.remove() 定时器（180ms）到期后，还原定时器应已一并清理
            jest.advanceTimersByTime(300);
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('样式基于 --mc-* token 与 --ti-success，不再硬编码浅色卡片', () => {
        const sidebar = createSidebar();
        mockTaskInfo({});
        sidebar._showTaskInfoModal('task_css');

        const css = document.querySelector('.od-taskinfo-overlay style')!.textContent!;
        // 深浅色由 MODAL_CSS 的 token 块驱动
        expect(css).toContain('var(--mc-card-bg)');
        expect(css).toContain('--ti-success');
        // 旧实现中的硬编码浅色样式应被移除
        expect(css).not.toContain('background: #fff');
        expect(css).not.toContain('od-taskinfo-card');
        // 值字段字体栈：等宽 + 中文回退到 UI 字体（避免中文落入系统等宽字体）
        expect(css).toContain("'Maple Mono'");
        expect(css).toContain("'HarmonyOS Sans'");
        // 弹窗显式声明 UI 字体
        expect(css).toContain('var(--font-sans');
    });

    test('点击关闭按钮后播放退出动画并移除弹窗', async () => {
        jest.useFakeTimers();
        try {
            const sidebar = createSidebar();
            mockTaskInfo({});
            sidebar._showTaskInfoModal('task_close');

            const overlay = document.querySelector('.od-taskinfo-overlay') as HTMLElement;
            overlay.querySelectorAll('[data-action="close"]').forEach((btn) => (btn as HTMLElement).click());
            expect(overlay.classList.contains('od-modal-leaving')).toBe(true);

            jest.advanceTimersByTime(300);
            expect(document.querySelector('.od-taskinfo-overlay')).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });
});
