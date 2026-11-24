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
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { InteractionDeliveryChannel } from '../../../main/aikernel/interaction/delivery.js';
import { MobileInteractionDeliveryEndpoint } from '../../../main/applications/mobileaccess/acp/mobile/interaction/delivery-endpoint.js';
import { MAX_INTERACTION_BYTES } from '../../../main/applications/mobileaccess/acp/mobile/interaction/message-mapper.js';

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

function fakeDeliveryChannel() {
    const closes: string[] = [];
    const channel: any = {
        ask: undefined,
        exit: undefined,
        subscribeEndpointReady: () => () => undefined,
        publishAskUser(request: unknown, answer: (response: unknown) => boolean) {
            channel.ask = { request, answer };
            return {
                delivered: true,
                close: (status: string) => closes.push(status)
            };
        },
        publishExitPlanMode(request: unknown, answer: (response: unknown) => boolean) {
            channel.exit = { request, answer };
            return {
                delivered: true,
                close: (status: string) => closes.push(status)
            };
        }
    };
    return { channel, closes };
}

function sizeBoundDeliveryChannel() {
    const channel = new InteractionDeliveryChannel(() => 'task-1');
    const extMethod = jest.fn(async () => ({}));
    channel.registerEndpoint(
        new MobileInteractionDeliveryEndpoint(
            'task-1',
            {
                extMethod,
                extNotification: async () => undefined
            } as unknown as AgentSideConnection,
            new AbortController().signal,
            { authorizeInteractionAnswer() {} },
            () => undefined
        )
    );
    return { channel, extMethod };
}

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

    it('无窗口但 Mobile 已投递时等待 Mobile 回答', async () => {
        widgetWindow = null;
        mainWindow = null;
        const remote = fakeDeliveryChannel();
        provider = new ElectronAskUserProvider(remote.channel);
        const pending = provider.prompt(askRequest);
        expect(remote.channel.ask.answer({ answers: { 0: ['A'] } })).toBe(true);
        await expect(pending).resolves.toEqual({ answers: { 0: ['A'] } });
    });

    it('超限 AskUser 不投递 Mobile 但仍显示并完成本地窗口', async () => {
        const remote = sizeBoundDeliveryChannel();
        provider = new ElectronAskUserProvider(remote.channel);
        const pending = provider.prompt({
            ...askRequest,
            questions: [{ ...askRequest.questions[0], question: 'x'.repeat(MAX_INTERACTION_BYTES + 1) }]
        });
        expect(mainSend).toHaveBeenCalledWith(
            'askUser:request',
            'ask-1',
            expect.objectContaining({ taskId: 'task-1' })
        );
        expect(remote.extMethod).not.toHaveBeenCalled();
        takeHandler('askUser:response')(null, 'ask-1', { answers: { 0: ['A'] } });
        await expect(pending).resolves.toMatchObject({ answers: { 0: ['A'] } });
    });

    it('本地先答后 Mobile 迟答失败并收到 superseded', async () => {
        const remote = fakeDeliveryChannel();
        provider = new ElectronAskUserProvider(remote.channel);
        const pending = provider.prompt(askRequest);
        takeHandler('askUser:response')(null, 'ask-1', { answers: { 0: ['A'] } });
        await expect(pending).resolves.toEqual({ answers: { 0: ['A'] }, cancelled: false });
        expect(remote.channel.ask.answer({ answers: { 0: ['B'] } })).toBe(false);
        expect(remote.closes).toEqual(['superseded']);
    });

    it('Mobile 先答后 dismiss renderer 并拒绝迟到本地回答', async () => {
        const remote = fakeDeliveryChannel();
        provider = new ElectronAskUserProvider(remote.channel);
        const pending = provider.prompt(askRequest);
        const local = takeHandler('askUser:response');
        expect(remote.channel.ask.answer({ answers: { 0: ['B'] } })).toBe(true);
        local(null, 'ask-1', { answers: { 0: ['A'] } });
        await expect(pending).resolves.toEqual({ answers: { 0: ['B'] } });
        expect(widgetSend).toHaveBeenCalledWith('askUser:dismiss', 'ask-1');
        expect(remote.closes).toEqual([]);
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

    it('在异步 Mode switch 前锁定 Mobile winner', async () => {
        const remote = fakeDeliveryChannel();
        provider = new ElectronExitPlanModeProvider(remote.channel);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const modeSwitcher = jest.fn(async () => gate);
        provider.setModeSwitcher(modeSwitcher);
        const pending = provider.promptAndSwitch('# plan', '/tmp/.plan/plan.md', 'task-1', 'Task', {
            planRelativePath: '.plan/plan.md'
        });
        const requestId = remote.channel.exit.request.requestId as string;
        const local = takeHandler('exitPlanMode:response');
        expect(remote.channel.exit.answer({ action: 'execute-standard' })).toBe(true);
        local(null, requestId, { action: 'continue-editing' });
        expect(modeSwitcher).toHaveBeenCalledTimes(1);
        release();
        await expect(pending).resolves.toEqual({ action: 'execute-standard' });
    });

    it('Mode switch 失败时安全降级且不重新开放败方', async () => {
        const remote = fakeDeliveryChannel();
        provider = new ElectronExitPlanModeProvider(remote.channel);
        provider.setModeSwitcher(async () => {
            throw new Error('switch failed');
        });
        const pending = provider.promptAndSwitch('# plan', '/tmp/.plan/plan.md', 'task-1', 'Task', {
            planRelativePath: '.plan/plan.md'
        });
        expect(remote.channel.exit.answer({ action: 'execute-standard' })).toBe(true);
        expect(remote.channel.exit.answer({ action: 'continue-editing' })).toBe(false);
        await expect(pending).resolves.toEqual({ action: 'continue-editing' });
    });

    it('超限 ExitPlanMode 不投递 Mobile 但仍显示并完成本地窗口', async () => {
        const remote = sizeBoundDeliveryChannel();
        provider = new ElectronExitPlanModeProvider(remote.channel);
        const pending = provider.promptAndSwitch(
            'x'.repeat(MAX_INTERACTION_BYTES + 1),
            '/tmp/.plan/large.md',
            'task-1',
            'Task',
            { planRelativePath: '.plan/large.md' }
        );
        expect(mainSend).toHaveBeenCalledWith(
            'exitPlanMode:request',
            expect.any(String),
            expect.objectContaining({ planFilePath: '/tmp/.plan/large.md' })
        );
        expect(remote.extMethod).not.toHaveBeenCalled();
        const requestId = mainSend.mock.calls.find(([channel]) => channel === 'exitPlanMode:request')?.[1] as string;
        takeHandler('exitPlanMode:response')(null, requestId, { action: 'continue-editing' });
        await expect(pending).resolves.toEqual({ action: 'continue-editing' });
    });
});

describe('AskUser / ExitPlanMode 的待回答申请重新投递', () => {
    interface WireRequest {
        requestId: string;
        params: any;
        answer(payload: unknown): void;
    }

    function reofferHarness(options: { holdTerminal?: boolean } = {}) {
        let releaseTerminal = (): void => undefined;
        // Keeps the close notification in flight so the finish window is observable.
        const terminalGate = options.holdTerminal
            ? new Promise<void>((resolve) => {
                  releaseTerminal = resolve;
              })
            : undefined;
        const channel = new InteractionDeliveryChannel(() => 'task-1');
        const wire: WireRequest[] = [];
        const closed: Array<{ requestId: string; status: string }> = [];
        const connection = {
            extMethod: (_method: string, params: any) =>
                new Promise((resolve) => {
                    wire.push({ requestId: params.requestId, params, answer: resolve });
                }),
            extNotification: async (_method: string, payload: any) => {
                closed.push({ requestId: payload.requestId, status: payload.status });
                await terminalGate;
            }
        } as unknown as AgentSideConnection;
        const endpoints: MobileInteractionDeliveryEndpoint[] = [];
        const attach = (): (() => void) => {
            const endpoint = new MobileInteractionDeliveryEndpoint(
                'task-1',
                connection,
                new AbortController().signal,
                { authorizeInteractionAnswer() {} },
                {
                    async sendFailed(send) {
                        await send();
                    },
                    async invalidateLoadedSession() {},
                    failConnection() {}
                },
                () => undefined
            );
            endpoints.push(endpoint);
            const unregister = channel.registerEndpoint(endpoint);
            // Replacing a loaded Session unregisters and disposes, exactly like the adapter does.
            return () => {
                unregister();
                endpoint.dispose();
            };
        };
        const settle = async (): Promise<void> => {
            for (let round = 0; round < 3; round += 1) {
                for (let index = 0; index < 8; index += 1) await Promise.resolve();
                await new Promise((resolve) => setImmediate(resolve));
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        };
        return {
            channel,
            wire,
            closed,
            attach,
            settle,
            releaseTerminal: () => releaseTerminal(),
            dispose: () => endpoints.forEach((endpoint) => endpoint.dispose())
        };
    }

    const exitRemote = { planRelativePath: '.plan/plan.md' } as any;

    it('AskUser 换 endpoint 后以原请求重新投递一次，新通道的回答结算原申请', async () => {
        const harness = reofferHarness();
        const detach = harness.attach();
        const provider = new ElectronAskUserProvider(harness.channel);
        try {
            const pending = provider.prompt(askRequest);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);
            const original = harness.wire[0];

            detach();
            harness.attach();
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(2);
            expect(harness.wire[1].requestId).toBe(original.requestId);
            // 原问题、原选项与原截止时间原样保留，不是新建申请。
            expect(harness.wire[1].params.questions).toEqual(original.params.questions);
            expect(harness.wire[1].params.expiresAt).toBe(original.params.expiresAt);

            // 重复就绪不重复投递。
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(2);

            // 旧 endpoint 的迟到回答已失效。
            original.answer({ answers: { 0: ['A'] } });
            await harness.settle();
            harness.wire[1].answer({ answers: { 0: ['B'] } });
            // 手机答案原样透传，旧 endpoint 的 A 不生效。
            await expect(pending).resolves.toEqual({ answers: { 0: ['B'] } });
        } finally {
            provider.cancelCurrent();
            harness.dispose();
        }
    });

    it('ExitPlanMode 换 endpoint 后以原计划重新投递一次', async () => {
        const harness = reofferHarness();
        const detach = harness.attach();
        const provider = new ElectronExitPlanModeProvider(harness.channel);
        try {
            const pending = provider.promptAndSwitch('# Plan', '/work/.plan/plan.md', 'task-1', 'demo', exitRemote);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);
            const original = harness.wire[0];

            detach();
            harness.attach();
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(2);
            expect(harness.wire[1].requestId).toBe(original.requestId);
            expect(harness.wire[1].params.planContent).toBe(original.params.planContent);
            expect(harness.wire[1].params.expiresAt).toBe(original.params.expiresAt);

            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(2);

            harness.wire[1].answer({
                schemaVersion: 1,
                requestId: original.requestId,
                action: 'continue-editing'
            });
            await expect(pending).resolves.toEqual({ action: 'continue-editing' });
        } finally {
            provider.cancelCurrent();
            harness.dispose();
        }
    });

    it('本地已回答的申请不复活，且结算后不再监听就绪', async () => {
        const harness = reofferHarness();
        const detach = harness.attach();
        const provider = new ElectronAskUserProvider(harness.channel);
        try {
            const pending = provider.prompt(askRequest);
            await harness.settle();
            takeHandler('askUser:response')({}, 'ask-1', { answers: { 0: ['A'] }, cancelled: false });
            await expect(pending).resolves.toEqual({ answers: { 0: ['A'] }, cancelled: false });

            detach();
            harness.attach();
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('Provider 只在申请在途期间订阅就绪，不按实例长期累积监听者', async () => {
        const harness = reofferHarness();
        harness.attach();
        // 每个 Task 都会新建 AskUser/ExitPlanMode Provider 且没有 dispose，构造期订阅会逐 Task 泄漏。
        const idle = Array.from({ length: 5 }, () => new ElectronAskUserProvider(harness.channel));
        let reached = 0;
        harness.channel.subscribeEndpointReady(() => {
            reached += 1;
        });
        harness.channel.notifyEndpointReady();
        expect(reached).toBe(1);

        const provider = idle[0];
        const pending = provider.prompt(askRequest);
        await harness.settle();
        takeHandler('askUser:response')({}, 'ask-1', { answers: { 0: ['A'] }, cancelled: false });
        await expect(pending).resolves.toEqual({ answers: { 0: ['A'] }, cancelled: false });
        harness.channel.notifyEndpointReady();
        await harness.settle();
        // 结算后重新投递不再发生：订阅随申请结束释放。
        expect(harness.wire).toHaveLength(1);
        harness.dispose();
    });

    it('delivers a follow-up AskUser issued while the previous one is still closing', async () => {
        const harness = reofferHarness({ holdTerminal: true });
        harness.attach();
        const provider = new ElectronAskUserProvider(harness.channel);
        try {
            const first = provider.prompt(askRequest);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);

            // The caller is the queue here: it awaits the answer and asks again immediately, while the
            // close notification for the first question still occupies the remote exit.
            let second: Promise<unknown> | undefined;
            const chained = first.then((answer) => {
                second = provider.prompt({ ...askRequest, requestId: 'ask-2' });
                return answer;
            });
            harness.wire[0].answer({ answers: { 0: ['A'] } });
            await expect(chained).resolves.toEqual({ answers: { 0: ['A'] } });
            await harness.settle();
            expect(second).toBeDefined();

            harness.releaseTerminal();
            await harness.settle();
            expect(harness.wire).toHaveLength(2);
            expect(harness.wire[1].requestId).toBe('ask-2');
            harness.wire[1].answer({ cancelled: true, answers: {} });
            await expect(second).resolves.toMatchObject({ cancelled: true });
        } finally {
            harness.releaseTerminal();
            provider.cancelCurrent();
            harness.dispose();
        }
    });

    it('queues concurrent phone-only AskUser requests until each remote close finishes', async () => {
        widgetWindow = null;
        mainWindow = null;
        const harness = reofferHarness({ holdTerminal: true });
        harness.attach();
        const provider = new ElectronAskUserProvider(harness.channel);
        try {
            const first = provider.prompt(askRequest);
            const second = provider.prompt({ ...askRequest, requestId: 'ask-2' });
            const third = provider.prompt({ ...askRequest, requestId: 'ask-3' });
            let secondSettled = false;
            void second.then(() => {
                secondSettled = true;
            });
            await harness.settle();
            expect(harness.wire.map((entry) => entry.requestId)).toEqual(['ask-1']);
            expect(secondSettled).toBe(false);

            harness.wire[0].answer({ answers: { 0: ['A'] } });
            await expect(first).resolves.toEqual({ answers: { 0: ['A'] } });
            await harness.settle();
            expect(harness.wire).toHaveLength(1);
            expect(secondSettled).toBe(false);

            harness.releaseTerminal();
            await harness.settle();
            expect(harness.wire[1].requestId).toBe('ask-2');
            harness.wire[1].answer({ answers: { 0: ['B'] } });
            await expect(second).resolves.toEqual({ answers: { 0: ['B'] } });
            await harness.settle();
            expect(harness.wire[2].requestId).toBe('ask-3');
            harness.wire[2].answer({ cancelled: true, answers: {} });
            await expect(third).resolves.toMatchObject({ cancelled: true });
            expect(provider.isPrompting()).toBe(false);
        } finally {
            harness.releaseTerminal();
            provider.cancelCurrent();
            harness.dispose();
        }
    });

    it('advances concurrent requests after a local winner and ignores the old remote answer', async () => {
        const harness = reofferHarness();
        harness.attach();
        const provider = new ElectronAskUserProvider(harness.channel);
        try {
            const first = provider.prompt(askRequest);
            const second = provider.prompt({ ...askRequest, requestId: 'ask-2' });
            await harness.settle();
            takeHandler('askUser:response')({}, 'ask-1', { answers: { 0: ['A'] } });
            await expect(first).resolves.toMatchObject({ answers: { 0: ['A'] } });
            await harness.settle();
            expect(harness.wire.map((entry) => entry.requestId)).toEqual(['ask-1', 'ask-2']);
            harness.wire[0].answer({ answers: { 0: ['B'] } });
            await harness.settle();
            harness.wire[1].answer({ answers: { 0: ['B'] } });
            await expect(second).resolves.toEqual({ answers: { 0: ['B'] } });
            expect(harness.closed).toContainEqual({ requestId: 'ask-1', status: 'superseded' });
        } finally {
            provider.cancelCurrent();
            harness.dispose();
        }
    });

    it('reoffers concurrent requests after reconnect without losing the queue or extending expiry', async () => {
        widgetWindow = null;
        mainWindow = null;
        const harness = reofferHarness();
        const detach = harness.attach();
        const provider = new ElectronAskUserProvider(harness.channel);
        const unsubscribe = jest.fn();
        const subscribe = harness.channel.subscribeEndpointReady.bind(harness.channel);
        jest.spyOn(harness.channel, 'subscribeEndpointReady').mockImplementation((listener) => {
            const stop = subscribe(listener);
            return () => {
                unsubscribe();
                stop();
            };
        });
        try {
            const first = provider.prompt(askRequest);
            const second = provider.prompt({ ...askRequest, requestId: 'ask-2' });
            await harness.settle();
            const original = harness.wire[0];
            detach();
            harness.attach();
            harness.channel.notifyEndpointReady();
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire.map((entry) => entry.requestId)).toEqual(['ask-1', 'ask-1']);
            expect(harness.wire[1].params.expiresAt).toBe(original.params.expiresAt);
            original.answer({ answers: { 0: ['A'] } });
            await harness.settle();
            harness.wire[1].answer({ answers: { 0: ['B'] } });
            await expect(first).resolves.toEqual({ answers: { 0: ['B'] } });
            await harness.settle();
            expect(harness.wire[2].requestId).toBe('ask-2');
            expect(unsubscribe).not.toHaveBeenCalled();
            harness.wire[2].answer({ answers: { 0: ['A'] } });
            await expect(second).resolves.toEqual({ answers: { 0: ['A'] } });
            expect(unsubscribe).toHaveBeenCalledTimes(1);
        } finally {
            provider.cancelCurrent();
            harness.dispose();
        }
    });

    it('advances the queue after expiry using the next request original deadline', async () => {
        widgetWindow = null;
        mainWindow = null;
        const harness = reofferHarness();
        harness.attach();
        const provider = new ElectronAskUserProvider(harness.channel);
        const start = Date.now();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
        const originalSetTimeout = globalThis.setTimeout;
        const timers = jest.spyOn(globalThis, 'setTimeout');
        try {
            const first = provider.prompt(askRequest);
            await harness.settle();
            clock.mockReturnValue(start + 1_000);
            const second = provider.prompt({ ...askRequest, requestId: 'ask-2' });
            const expiry = timers.mock.calls.filter(([, delay]) => delay === 600_000);
            expect(expiry).toHaveLength(2);
            clock.mockReturnValue(start + 600_000);
            (expiry[0][0] as () => void)();
            await expect(first).resolves.toMatchObject({ cancelled: true });
            await harness.settle();
            expect(harness.wire[1].requestId).toBe('ask-2');
            expect(harness.wire[1].params.expiresAt).toBe(start + 601_000);
            expect(harness.closed).toContainEqual({ requestId: 'ask-1', status: 'timeout' });
            harness.wire[0].answer({ answers: { 0: ['A'] } });
            await harness.settle();
            harness.wire[1].answer({ answers: { 0: ['B'] } });
            await expect(second).resolves.toEqual({ answers: { 0: ['B'] } });
        } finally {
            clock.mockRestore();
            timers.mockRestore();
            // Node 26 的 Jest VM 中 mockRestore 可能删除全局绑定，显式恢复原始函数。
            globalThis.setTimeout = originalSetTimeout;
            provider.cancelCurrent();
            harness.dispose();
        }
    });

    it('cancels all queued requests during remote close without reviving them on release', async () => {
        widgetWindow = null;
        mainWindow = null;
        const harness = reofferHarness({ holdTerminal: true });
        harness.attach();
        const provider = new ElectronAskUserProvider(harness.channel);
        try {
            const first = provider.prompt(askRequest);
            const second = provider.prompt({ ...askRequest, requestId: 'ask-2' });
            const third = provider.prompt({ ...askRequest, requestId: 'ask-3' });
            await harness.settle();
            harness.wire[0].answer({ answers: { 0: ['A'] } });
            await expect(first).resolves.toEqual({ answers: { 0: ['A'] } });
            provider.cancelCurrent();
            await expect(second).resolves.toEqual({ answers: {}, cancelled: true });
            await expect(third).resolves.toEqual({ answers: {}, cancelled: true });
            expect(provider.isPrompting()).toBe(false);
            harness.releaseTerminal();
            harness.channel.notifyEndpointReady();
            await harness.settle();
            expect(harness.wire).toHaveLength(1);
        } finally {
            harness.releaseTerminal();
            provider.cancelCurrent();
            harness.dispose();
        }
    });

    it('delivers a follow-up ExitPlanMode issued while the previous one is still closing', async () => {
        const harness = reofferHarness({ holdTerminal: true });
        harness.attach();
        const provider = new ElectronExitPlanModeProvider(harness.channel);
        try {
            const first = provider.promptAndSwitch('# first', '/work/.plan/a.md', 'task-1', 'demo', exitRemote);
            await harness.settle();
            expect(harness.wire).toHaveLength(1);

            let second: Promise<unknown> | undefined;
            const chained = first.then((answer) => {
                second = provider.promptAndSwitch('# second', '/work/.plan/b.md', 'task-1', 'demo', exitRemote);
                return answer;
            });
            harness.wire[0].answer({
                schemaVersion: 1,
                requestId: harness.wire[0].requestId,
                action: 'continue-editing'
            });
            await expect(chained).resolves.toEqual({ action: 'continue-editing' });
            await harness.settle();
            expect(second).toBeDefined();

            harness.releaseTerminal();
            await harness.settle();
            expect(harness.wire).toHaveLength(2);
            expect(harness.wire[1].params.planContent).toBe('# second');
            harness.wire[1].answer({
                schemaVersion: 1,
                requestId: harness.wire[1].requestId,
                action: 'continue-editing'
            });
            await expect(second).resolves.toEqual({ action: 'continue-editing' });
        } finally {
            harness.releaseTerminal();
            provider.cancelCurrent();
            harness.dispose();
        }
    });

    it.each(['askUser', 'exitPlanMode'] as const)(
        'does not auto-settle a follow-up %s that only waits for the closing exit, with no window open',
        async (kind) => {
            const harness = reofferHarness({ holdTerminal: true });
            harness.attach();
            // No Electron window at all: the phone is the only way to answer.
            widgetWindow = null;
            mainWindow = null;
            const provider =
                kind === 'askUser'
                    ? new ElectronAskUserProvider(harness.channel)
                    : new ElectronExitPlanModeProvider(harness.channel);
            const start = (tag: string): Promise<any> =>
                kind === 'askUser'
                    ? (provider as any).prompt({ ...askRequest, requestId: tag })
                    : (provider as any).promptAndSwitch(tag, '/work/.plan/a.md', 'task-1', 'demo', exitRemote);
            try {
                const first = start('first');
                await harness.settle();
                expect(harness.wire).toHaveLength(1);

                let second: Promise<any> | undefined;
                const chained = first.then((answer: unknown) => {
                    second = start('second');
                    return answer;
                });
                harness.wire[0].answer(
                    kind === 'askUser'
                        ? { answers: { 0: ['A'] } }
                        : { schemaVersion: 1, requestId: harness.wire[0].requestId, action: 'continue-editing' }
                );
                await chained;
                await harness.settle();
                expect(second).toBeDefined();

                // The exit is merely busy, so the no-answer-path fallback must not fire yet.
                let settledEarly = false;
                void second!.then(() => {
                    settledEarly = true;
                });
                await harness.settle();
                expect(settledEarly).toBe(false);

                harness.releaseTerminal();
                await harness.settle();
                expect(harness.wire).toHaveLength(2);
                harness.wire[1].answer(
                    kind === 'askUser'
                        ? { cancelled: true, answers: {} }
                        : { schemaVersion: 1, requestId: harness.wire[1].requestId, action: 'continue-editing' }
                );
                await expect(second).resolves.toBeDefined();
            } finally {
                harness.releaseTerminal();
                provider.cancelCurrent();
                harness.dispose();
            }
        }
    );
});
