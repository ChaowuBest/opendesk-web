import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 文件回收站模态弹窗（trash-floating-window）：
 * 切换"仅搜索该任务删除的文件"复选框时，应以静默方式刷新列表——
 * 在结果返回前保留当前列表与滚动位置，而不是先清空并渲染"加载中…"，
 * 后者会让弹窗卡片高度骤变（整窗闪烁/跳动）。
 */
describe('trash floating window scope switch', () => {
    let searchMock: jest.Mock;
    let hostEl: HTMLElement;
    let scopeCheckbox: HTMLInputElement;
    let listEl: HTMLElement;

    async function flush(): Promise<void> {
        // 宏任务两轮，确保组件内 await 链全部跑完
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    function entriesOfTask(taskId: string): Array<Record<string, unknown>> {
        return [
            {
                uuid: '11111111-1111-4111-8111-111111111111',
                original_path: '/tmp/task-file-a.txt',
                size: 100,
                deleted_at: '2026-01-01T00:00:00.000Z',
                task_id: taskId
            },
            {
                uuid: '22222222-2222-4222-8222-222222222222',
                original_path: '/tmp/task-file-b.txt',
                size: 200,
                deleted_at: '2026-01-01T00:00:00.000Z',
                task_id: taskId
            }
        ];
    }

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            localStorage: {
                getItem: () => null,
                setItem: () => undefined,
                removeItem: () => undefined
            },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        (window.Element.prototype as any).getRootNode = function () {
            return window.document;
        };
        (window.Element.prototype as any).closest = () => null;
        (window.Element.prototype as any).scrollIntoView = () => undefined;

        searchMock = jest.fn();
        (window as any).trashAPI = {
            search: searchMock,
            getTaskContext: jest.fn(async () => ({
                task_name: '测试任务',
                last_user_message: '帮我找回文件'
            })),
            restore: jest.fn(),
            openEntry: jest.fn()
        };

        await import('../../../renderer/components/trashFloatingWindow.ts');
    });

    afterAll(() => {
        delete (window as any).trashAPI;
    });

    async function openTaskScope(): Promise<void> {
        searchMock.mockResolvedValueOnce({
            entries: entriesOfTask('task_1'),
            total: 2
        });
        const el = document.createElement('trash-floating-window');
        document.body.appendChild(el);
        hostEl = el;
        el.open({ taskId: 'task_1' });
        await flush();

        scopeCheckbox = el.querySelector('.trash-scope-only') as HTMLInputElement;
        listEl = el.querySelector('.trash-list') as HTMLElement;
    }

    test('切换范围时保留旧列表（不渲染加载态），结果返回后整体替换', async () => {
        await openTaskScope();

        // 首次加载：任务范围内 2 条（linkedom 不映射 checked property，按 attribute 断言）
        expect(scopeCheckbox.hasAttribute('checked')).toBe(true);
        expect(listEl.querySelectorAll('.trash-item')).toHaveLength(2);
        expect(listEl.textContent).toContain('task-file-a.txt');

        // 第二次 search 挂起：模拟慢返回，验证切换瞬间不清空列表
        let resolveSecond!: (value: unknown) => void;
        searchMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveSecond = resolve;
                })
        );

        // 取消勾选"仅该任务"→ 切换为全局搜索
        scopeCheckbox.checked = false;
        scopeCheckbox.dispatchEvent(new window.Event('change'));
        await flush();

        // 关键断言：结果返回前，旧列表仍完整可见（无"加载中"占位、条目未清空）
        expect(searchMock).toHaveBeenCalledTimes(2);
        expect(searchMock.mock.calls[1][0]).toMatchObject({ scope: 'global' });
        expect(searchMock.mock.calls[1][0].taskId).toBeUndefined();
        expect(listEl.querySelectorAll('.trash-item')).toHaveLength(2);
        expect(listEl.textContent).toContain('task-file-a.txt');
        expect(listEl.textContent).not.toContain('加载中');

        // 结果返回后整体替换为全局列表
        resolveSecond({
            entries: [
                {
                    uuid: '33333333-3333-4333-8333-333333333333',
                    original_path: '/tmp/global-file.txt',
                    size: 300,
                    deleted_at: '2026-01-02T00:00:00.000Z',
                    task_id: 'task_2'
                }
            ],
            total: 1
        });
        await flush();

        expect(listEl.querySelectorAll('.trash-item')).toHaveLength(1);
        expect(listEl.textContent).toContain('global-file.txt');
        expect(listEl.textContent).not.toContain('task-file-a.txt');
    });

    test('搜索框与任务信息固定在头部：列表位于独立滚动容器内，与头部同级', async () => {
        await openTaskScope();

        const body = hostEl.querySelector('.trash-modal-body');
        expect(body).not.toBeNull();
        // 滚动容器是 body 的直接子元素，与搜索框/任务信息同级（头部不参与滚动）
        const listScroll = body.querySelector(':scope > .trash-list-scroll') as HTMLElement | null;
        expect(listScroll).not.toBeNull();
        expect(body.querySelector(':scope > .trash-search')).not.toBeNull();
        expect(body.querySelector(':scope > .trash-task-info')).not.toBeNull();
        // 列表在滚动容器内部
        expect(listScroll.querySelector('.trash-list')).not.toBeNull();
    });

    test('切换范围后若请求失败，展示加载失败状态而非残留旧列表', async () => {
        await openTaskScope();

        searchMock.mockRejectedValueOnce(new Error('boom'));
        scopeCheckbox.checked = false;
        scopeCheckbox.dispatchEvent(new window.Event('change'));
        await flush();

        expect(listEl.textContent).toContain('加载回收站失败');
    });
});
