// 回归：主页输入框发送首条消息时，createTask 返回的是 taskId 字符串（main 进程
// taskManager:createTask 的 data 就是裸字符串）。此前错误地写成 task.task_id，
// 对字符串取属性得到 undefined，导致 openTask(undefined) 创建 task_id="undefined"
// 的 task-view，getFullTask 报 "task undefined not found"，界面卡在 loading 白屏。
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const newTaskId = 'task_new_123';

describe('homepage first-message creates and opens task', () => {
    let openTaskMock: ReturnType<typeof jest.fn>;
    let submitMessageMock: ReturnType<typeof jest.fn>;
    let createTaskMock: ReturnType<typeof jest.fn>;

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
            getComputedStyle: () => ({ marginTop: '0px', marginBottom: '0px' }),
            requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0),
            MutationObserver: class {
                observe() {}
                disconnect() {}
            },
            ResizeObserver: class {
                observe() {}
                disconnect() {}
                unobserve() {}
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
        (window as any).matchMedia = () => ({ matches: true });
        (window as any).settingAPI = {
            loadSettingObject: async () => ({ locale: 'zh-CN' }),
            onSettingChanged: async () => () => undefined
        };
        (window as any).workspaceAPI = {
            getEffectiveWorkspace: async () => '/tmp/ws',
            getRecentWorkspaces: async () => []
        };
        (window as any).applicationRegistryAPI = {
            getApplicationList: async () => [],
            call: async () => undefined,
            subscribeEvent: async () => () => undefined
        };
        createTaskMock = jest.fn(async () => newTaskId);
        submitMessageMock = jest.fn(async () => undefined);
        (window as any).taskManagerAPI = {
            createTask: createTaskMock,
            submitMessage: submitMessageMock
        };
        openTaskMock = jest.fn();
        (window as any).globalControlAPI = {
            openTask: openTaskMock,
            openHomePage: jest.fn()
        };
        // homepage 的模板中使用 <agent-input>，测试环境无需其真实实现，
        // 用空注册抢占 define，避免 homepage 之外的组件注册报错
        const realDefine = window.customElements.define.bind(window.customElements);
        (window.customElements as any).define = (name: string, ctor: any, opts?: any) => {
            if (window.customElements.get(name)) return;
            realDefine(name, ctor, opts);
        };
        await import('../../../renderer/components/homepage.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        openTaskMock.mockClear();
        submitMessageMock.mockClear();
        createTaskMock.mockClear();
    });

    test('发送首条消息后 openTask 收到 createTask 返回的 taskId 本身', async () => {
        const page = document.createElement('home-page');
        document.body.appendChild(page);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const agentInput = page.querySelector('#agent-input-main') as HTMLElement;
        expect(agentInput).not.toBeNull();

        const submitDetail = { message: '帮我创建一个 demo 项目' };
        agentInput.dispatchEvent(new CustomEvent('submit', { detail: submitDetail }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(createTaskMock).toHaveBeenCalledTimes(1);
        expect(submitMessageMock).toHaveBeenCalledWith(newTaskId, submitDetail);
        expect(openTaskMock).toHaveBeenCalledTimes(1);
        expect(openTaskMock).toHaveBeenCalledWith(newTaskId);
    });
});
