/**
 * 复现多窗口场景下 askUser / exitPlanMode 面板请求路由错误的问题：
 *
 * ElectronAskUserProvider / ElectronExitPlanModeProvider 曾把面板请求发给
 * getAllWindows() 中第一个未销毁的窗口。任务状态浮窗（pill/card）等常驻子窗口
 * 一旦排在主窗口之前，请求会发给没有面板组件的页面，导致询问面板永不弹出。
 *
 * 期望行为：askUser:request / exitPlanMode:request / 对应 dismiss 事件
 * 广播到所有未销毁窗口，由挂载了组件的窗口响应（requestId 匹配保证幂等）。
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const ipcMainMock = {
    on: jest.fn(),
    removeListener: jest.fn(),
    handle: jest.fn()
};

let widgetSend: ReturnType<typeof jest.fn>;
let mainSend: ReturnType<typeof jest.fn>;
let widgetWindow: any;
let mainWindow: any;

function makeWindow(send: ReturnType<typeof jest.fn>) {
    return {
        isDestroyed: () => false,
        webContents: { send },
        show: jest.fn(),
        focus: jest.fn()
    };
}

jest.unstable_mockModule('../../../utils/electron.js', () => ({
    electron: () => ({
        // 悬浮窗排在首位：模拟主窗口销毁重建后排在常驻浮窗之后的场景
        BrowserWindow: {
            getAllWindows: () => [widgetWindow, mainWindow].filter(Boolean)
        },
        ipcMain: ipcMainMock,
        Notification: { isSupported: () => false }
    })
}));

const { ElectronAskUserProvider } = await import('../../../main/aikernel/interaction/electronAskUser.js');
const { ElectronExitPlanModeProvider } = await import('../../../main/aikernel/interaction/electronExitPlanMode.js');

const askRequest = {
    requestId: 'ask-1',
    questions: [
        {
            question: '选哪个方案？',
            header: '方案',
            options: [
                { label: 'A', description: 'a' },
                { label: 'B', description: 'b' }
            ],
            multiple: false
        }
    ],
    taskId: 'task-1',
    taskName: 'demo'
} as any;

/** 取出 provider 注册在 ipcMain 上的响应回调 */
function takeHandler(channel: string): (event: unknown, requestId: string, data: unknown) => void {
    const call = ipcMainMock.on.mock.calls.find(([c]) => c === channel);
    return call?.[1] as (event: unknown, requestId: string, data: unknown) => void;
}

beforeEach(() => {
    widgetSend = jest.fn();
    mainSend = jest.fn();
    widgetWindow = makeWindow(widgetSend);
    mainWindow = makeWindow(mainSend);
    ipcMainMock.on.mockClear();
    ipcMainMock.removeListener.mockClear();
});

describe('ElectronAskUserProvider 多窗口广播', () => {
    let provider: InstanceType<typeof ElectronAskUserProvider>;

    beforeEach(() => {
        provider = new ElectronAskUserProvider();
    });

    // 用例失败时 pending 的 10 分钟超时 timer 可能未清理，open handle 会挂起 jest 进程
    afterEach(() => {
        provider.cancelCurrent();
    });

    it('askUser:request 应广播到所有窗口（悬浮窗在前也不例外），响应可正确 resolve', async () => {
        const pending = provider.prompt(askRequest);

        expect(widgetSend).toHaveBeenCalledWith(
            'askUser:request',
            'ask-1',
            expect.objectContaining({ taskId: 'task-1' })
        );
        expect(mainSend).toHaveBeenCalledWith(
            'askUser:request',
            'ask-1',
            expect.objectContaining({ taskId: 'task-1' })
        );

        takeHandler('askUser:response')(null, 'ask-1', { answers: { '0': ['A'] } });
        const resp = await pending;
        expect(resp.answers['0']).toEqual(['A']);
        expect(resp.cancelled).toBeFalsy();

        // settle 后重复响应应被忽略（多窗口重复响应幂等）
        takeHandler('askUser:response')(null, 'ask-1', { answers: { '0': ['B'] } });
        expect(ipcMainMock.removeListener).toHaveBeenCalledWith('askUser:response', expect.any(Function));
    });

    it('cancelCurrent 应向所有窗口广播 askUser:dismiss 并返回 cancelled', async () => {
        const pending = provider.prompt(askRequest);

        provider.cancelCurrent();
        const resp = await pending;

        expect(resp.cancelled).toBe(true);
        expect(widgetSend).toHaveBeenCalledWith('askUser:dismiss', 'ask-1');
        expect(mainSend).toHaveBeenCalledWith('askUser:dismiss', 'ask-1');
    });

    it('无可用窗口时立即返回 cancelled', async () => {
        widgetWindow = null;
        mainWindow = null;
        await expect(provider.prompt(askRequest)).resolves.toEqual({ answers: {}, cancelled: true });
    });

    it('并发多个 askUser 时 cancelCurrent 应取消全部 pending（避免旧 pending 泄漏）', async () => {
        const p1 = provider.prompt(askRequest);
        const p2 = provider.prompt({ ...askRequest, requestId: 'ask-2' });
        const p3 = provider.prompt({ ...askRequest, requestId: 'ask-3' });

        provider.cancelCurrent();

        await expect(p1).resolves.toEqual({ answers: {}, cancelled: true });
        await expect(p2).resolves.toEqual({ answers: {}, cancelled: true });
        await expect(p3).resolves.toEqual({ answers: {}, cancelled: true });

        const dismissed = widgetSend.mock.calls
            .filter(([channel]) => channel === 'askUser:dismiss')
            .map((call) => call[1]);
        expect(dismissed).toEqual(expect.arrayContaining(['ask-1', 'ask-2', 'ask-3']));
    });

    it('并发多个 askUser 时逐个响应对应 requestId，互不干扰', async () => {
        const p1 = provider.prompt(askRequest);
        const p2 = provider.prompt({ ...askRequest, requestId: 'ask-2' });

        // 并发注册了多个 response handler，逐一触发，只有 requestId 匹配的 handler 生效
        const handlers = ipcMainMock.on.mock.calls
            .filter(([channel]) => channel === 'askUser:response')
            .map((call) => call[1] as (event: unknown, requestId: string, data: unknown) => void);

        for (const handler of handlers) {
            handler(null, 'ask-2', { answers: { '0': ['B'] } });
        }
        await expect(p2).resolves.toMatchObject({ answers: { '0': ['B'] } });

        for (const handler of handlers) {
            handler(null, 'ask-1', { answers: { '0': ['A'] } });
        }
        await expect(p1).resolves.toMatchObject({ answers: { '0': ['A'] } });
    });
});

describe('ElectronExitPlanModeProvider 多窗口广播', () => {
    let provider: InstanceType<typeof ElectronExitPlanModeProvider>;

    beforeEach(() => {
        provider = new ElectronExitPlanModeProvider();
    });

    afterEach(() => {
        provider.cancelCurrent();
    });

    it('exitPlanMode:request 应广播到所有窗口并正确 resolve', async () => {
        const pending = provider.promptAndSwitch('# plan', '/tmp/plan.md', 'task-1');

        expect(widgetSend).toHaveBeenCalledWith(
            'exitPlanMode:request',
            expect.any(String),
            expect.objectContaining({ planFilePath: '/tmp/plan.md' })
        );
        expect(mainSend).toHaveBeenCalledWith(
            'exitPlanMode:request',
            expect.any(String),
            expect.objectContaining({ planFilePath: '/tmp/plan.md' })
        );

        const requestId = widgetSend.mock.calls[0][1] as string;
        takeHandler('exitPlanMode:response')(null, requestId, { action: 'execute-standard' });
        await expect(pending).resolves.toEqual({ action: 'execute-standard' });
    });

    it('cancelCurrent 应向所有窗口广播 exitPlanMode:dismiss 并返回 continue-editing', async () => {
        const pending = provider.promptAndSwitch('# plan', '/tmp/plan.md', 'task-2');

        provider.cancelCurrent();
        await expect(pending).resolves.toEqual({ action: 'continue-editing' });

        expect(widgetSend).toHaveBeenCalledWith('exitPlanMode:dismiss', expect.any(String));
        expect(mainSend).toHaveBeenCalledWith('exitPlanMode:dismiss', expect.any(String));
    });
});
