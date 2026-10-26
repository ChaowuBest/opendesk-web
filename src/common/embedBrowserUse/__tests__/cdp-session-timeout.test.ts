import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { CDPSession } from '../cdp/session.js';

/**
 * 回归测试：CDP 命令挂起时限时失败。
 *
 * 背景：debugger.sendCommand 在页面导航竞态 / debugger 中途 detach / webview
 * 状态异常时可能永不 resolve。此前 CDPSession.send 没有超时，一次挂起的命令
 * 会让持有它的独占锁操作永久悬挂，最终使整个任务的浏览器队列卡死。超时后
 * 必须断开并标记未 attach，让下一次 send 重新 attach 一个干净的 debugger。
 */
function makeWebContents(sendCommandImpl: (method: string, params: any) => Promise<any>, initiallyAttached = true) {
    let attachedFlag = initiallyAttached;
    return {
        id: 42,
        isDestroyed: () => false,
        debugger: {
            isAttached: () => attachedFlag,
            attach: jest.fn(() => {
                attachedFlag = true;
            }),
            detach: jest.fn(() => {
                attachedFlag = false;
            }),
            on: jest.fn(),
            removeListener: jest.fn(),
            sendCommand: jest.fn(sendCommandImpl)
        }
    } as any;
}

describe('CDPSession command timeout', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        // 超时/恢复路径的实现会 console.warn 记录原因，这正是被测行为，静默即可
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('send rejects with a timeout when sendCommand never resolves', async () => {
        const wc = makeWebContents(() => new Promise(() => undefined));
        const session = await CDPSession.create(wc);

        const rejection = expect(session.send('Runtime.evaluate', {}, 2000)).rejects.toThrow(
            'CDP command Runtime.evaluate timed out after 2000ms'
        );
        await jest.advanceTimersByTimeAsync(2000);
        await rejection;
    });

    test('a timed-out send detaches the debugger so the next send re-attaches', async () => {
        // 未 attach 状态 → 连接由本会话建立，超时后本会话负责 detach 重建
        const wc = makeWebContents(() => new Promise(() => undefined), false);
        const session = await CDPSession.create(wc);

        const rejection = expect(session.send('Runtime.evaluate', {}, 2000)).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(2000);
        await rejection;

        expect(wc.debugger.detach).toHaveBeenCalled();
        expect(session.attached).toBe(false);
    });

    test('a timed-out session recovers: the next send re-attaches and works', async () => {
        const sendCommand = jest.fn<(method: string, params: any) => Promise<any>>(() => new Promise(() => undefined));
        const wc = makeWebContents(sendCommand, false);
        const session = await CDPSession.create(wc);

        // First command wedges -> times out and detaches.
        const rejection = expect(session.send('Runtime.evaluate', {}, 2000)).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(2000);
        await rejection;
        expect(wc.debugger.detach).toHaveBeenCalledTimes(1);

        // Debugger is now detached; the next send must re-attach and complete.
        sendCommand.mockImplementationOnce(async () => ({ result: { value: 2 } }));
        // 重新探测 js 上下文后 attach（isAttached 现在为 false）
        const probe = session.send('Runtime.evaluate', {}, 2000);
        await jest.advanceTimersByTimeAsync(10);
        await expect(probe).resolves.toEqual({ result: { value: 2 } });

        expect(wc.debugger.attach).toHaveBeenCalled();
        expect(session.attached).toBe(true);
    });

    test('a disposed session never resurrects: send throws instead of re-attaching', async () => {
        const wc = makeWebContents(async () => ({ result: { value: 1 } }));
        const session = await CDPSession.create(wc);

        session.dispose();
        expect(session.attached).toBe(false);

        await expect(session.send('Runtime.evaluate', {}, 2000)).rejects.toThrow('session is disposed');
        // 已 disposed 的 session 不得重新 attach 到 webContents 的 debugger 上。
        expect(wc.debugger.attach).not.toHaveBeenCalled();
    });

    test('send resolves normally when the command completes in time', async () => {
        const wc = makeWebContents(async () => ({ result: { value: 2 } }));
        const session = await CDPSession.create(wc);

        const result = session.send('Runtime.evaluate', {}, 2000);
        await jest.advanceTimersByTimeAsync(10);
        await expect(result).resolves.toEqual({ result: { value: 2 } });

        expect(session.attached).toBe(true);
        expect(wc.debugger.detach).not.toHaveBeenCalled();
    });

    test('a timed-out send on a shared attachment does not detach someone else s connection', async () => {
        // debugger 已被别的会话 attach：本条会话只是复用连接，超时不能把
        // 整条连接 detach 掉（会打断对方正在进行的 CDP 操作）。
        const wc = makeWebContents(() => new Promise(() => undefined), true);
        const session = await CDPSession.create(wc);

        const rejection = expect(session.send('Runtime.evaluate', {}, 2000)).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(2000);
        await rejection;

        expect(wc.debugger.detach).not.toHaveBeenCalled();
    });

    test('a shared-attachment timeout still recovers: the next send resets the wedged connection', async () => {
        // 共享连接超时后不能立刻 detach，但也不能就此失去恢复能力：下一次真的
        // 要发命令时必须重置这条已证明挂死的连接并接管，否则该会话此后每次
        // send 都会在同一个挂死连接上超时，浏览器永久失去响应。
        const sendCommand = jest.fn<(method: string, params: any) => Promise<any>>(() => new Promise(() => undefined));
        const wc = makeWebContents(sendCommand, true);
        const session = await CDPSession.create(wc);
        // 连接是别人的，创建会话时没有 attach
        expect(wc.debugger.attach).not.toHaveBeenCalled();

        const rejection = expect(session.send('Runtime.evaluate', {}, 2000)).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(2000);
        await rejection;
        expect(wc.debugger.detach).not.toHaveBeenCalled();

        // 恢复：下一次 send 重置连接并接管，命令正常返回
        sendCommand.mockImplementationOnce(async () => ({ result: { value: 2 } }));
        const probe = session.send('Runtime.evaluate', {}, 2000);
        await jest.advanceTimersByTimeAsync(10);
        await expect(probe).resolves.toEqual({ result: { value: 2 } });

        expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
        expect(wc.debugger.attach).toHaveBeenCalledTimes(1);
        expect(session.attached).toBe(true);
    });

    test('a stale "not attached" retry does not take over a connection someone else rebuilt', async () => {
        // 连接在外部断掉（本会话没收到 detach 事件）后被别的会话抢先重建：
        // 本会话的重试会复用它，但不得继续声称拥有，否则 dispose 时会把别人
        // 重建的连接 detach 掉。
        const sendCommand = jest.fn<(method: string, params: any) => Promise<any>>(async () => ({
            result: { value: 2 }
        }));
        const wc = makeWebContents(sendCommand, false);
        const session = await CDPSession.create(wc);
        expect(wc.debugger.attach).toHaveBeenCalledTimes(1);

        // 外部断连（不派发事件），别的会话重新 attach，然后清空记录只看后续
        wc.debugger.detach();
        wc.debugger.attach();
        wc.debugger.detach.mockClear();
        wc.debugger.attach.mockClear();

        sendCommand.mockImplementationOnce(async () => {
            throw new Error('Debugger is not attached to the target');
        });
        const probe = session.send('Runtime.evaluate', {}, 2000);
        await jest.advanceTimersByTimeAsync(10);
        await expect(probe).resolves.toEqual({ result: { value: 2 } });

        // 命令走的复用路径，本会话没有 attach → dispose 不得 detach 别人的连接
        expect(wc.debugger.attach).not.toHaveBeenCalled();
        session.dispose();
        expect(wc.debugger.detach).not.toHaveBeenCalled();
    });

    test('a stale detach event after re-attach does not reset the connection state', async () => {
        // detach 事件的派发时机与连接重建之间存在窗口（不同 Electron 版本的派发时机
        // 不同）：本会话超时重建连接后，旧连接的 detach 事件仍可能被观察到。此时
        // debugger 实际是连接状态，不能把刚建立的连接标记成断开（否则会丢
        // ownership，dispose 时漏掉 detach）。
        const wc = makeWebContents(async () => ({ result: { value: 2 } }), false);
        const session = await CDPSession.create(wc);
        expect(session.attached).toBe(true);

        // 模拟迟到的 detach 事件：原生状态仍是 attached
        const detachHandler = wc.debugger.on.mock.calls.find(([event]) => event === 'detach')?.[1];
        detachHandler({}, 'devtools');

        expect(session.attached).toBe(true);
        session.dispose();
        expect(wc.debugger.detach).toHaveBeenCalled();
    });

    test('a stale detach event cancels a pending connection reset', async () => {
        // 共享连接超时 → 标记待重建；随后连接被所有者重建，迟到的 detach 事件
        // 到达时原生已是连接状态。标记必须一起清掉，否则下一次 send 会把这条
        // 刚被重建好的健康连接再 detach 一次。
        const sendCommand = jest.fn<(method: string, params: any) => Promise<any>>(() => new Promise(() => undefined));
        const wc = makeWebContents(sendCommand, true);
        const session = await CDPSession.create(wc);

        const rejection = expect(session.send('Runtime.evaluate', {}, 2000)).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(2000);
        await rejection;
        expect(wc.debugger.detach).not.toHaveBeenCalled();

        // 迟到的 detach 事件：原生仍是 attached（连接已被所有者重建）
        const detachHandler = wc.debugger.on.mock.calls.find(([event]) => event === 'detach')?.[1];
        detachHandler({}, 'target closed');

        sendCommand.mockImplementationOnce(async () => ({ result: { value: 2 } }));
        const probe = session.send('Runtime.evaluate', {}, 2000);
        await jest.advanceTimersByTimeAsync(10);
        await expect(probe).resolves.toEqual({ result: { value: 2 } });

        expect(wc.debugger.detach).not.toHaveBeenCalled();
        expect(wc.debugger.attach).not.toHaveBeenCalled();
    });

    test('a command killed by a detach is retried instead of failing the caller', async () => {
        // Electron 在连接被 detach 的那一刻用 "target closed while handling command"
        // 拒绝在途命令（小写 t）。恢复路径必须认得它，否则共享连接被别的会话重置
        // 后，调用方拿到的是这句对使用者毫无意义的错误，而不是重连后的结果。
        const sendCommand = jest.fn<(method: string, params: any) => Promise<any>>(async () => ({
            result: { value: 2 }
        }));
        const wc = makeWebContents(sendCommand, false);
        const session = await CDPSession.create(wc);
        wc.debugger.attach.mockClear();

        sendCommand.mockImplementationOnce(async () => {
            wc.debugger.detach();
            throw new Error('target closed while handling command');
        });
        const probe = session.send('Runtime.evaluate', {}, 2000);
        await jest.advanceTimersByTimeAsync(10);
        await expect(probe).resolves.toEqual({ result: { value: 2 } });

        // 连接已经没了 → 重试路径重新 attach 一次
        expect(wc.debugger.attach).toHaveBeenCalledTimes(1);
    });

    test('"No target available" is treated as a lost connection, not a hard failure', async () => {
        // 连接没了但浏览器侧没有 'not attached' 之类文案：Electron 在
        // sendCommand 前发现 agent host 已不存在，直接报 "No target available"。
        const sendCommand = jest.fn<(method: string, params: any) => Promise<any>>(async () => ({
            result: { value: 2 }
        }));
        const wc = makeWebContents(sendCommand, false);
        const session = await CDPSession.create(wc);
        wc.debugger.attach.mockClear();

        sendCommand.mockImplementationOnce(async () => {
            wc.debugger.detach();
            throw new Error('No target available');
        });
        const probe = session.send('Runtime.evaluate', {}, 2000);
        await jest.advanceTimersByTimeAsync(10);
        await expect(probe).resolves.toEqual({ result: { value: 2 } });

        expect(wc.debugger.attach).toHaveBeenCalledTimes(1);
    });

    test('a session that fails to attach leaves no listeners on the debugger', async () => {
        // attach 失败（如 DevTools 已占用 debugger）时调用方拿不到 session，无法
        // dispose：create 必须自己收回已注册的 message/detach 监听，否则每失败
        // 一次就在 webContents.debugger 上多留一组闭包。
        const wc = makeWebContents(async () => ({ result: { value: 1 } }), false);
        wc.debugger.attach.mockImplementation(() => {
            throw new Error('Debugger is already attached to the target');
        });

        await expect(CDPSession.create(wc)).rejects.toThrow('Failed to attach CDP debugger');

        expect(wc.debugger.on).toHaveBeenCalledTimes(2);
        expect(wc.debugger.removeListener).toHaveBeenCalledTimes(2);
        expect(wc.debugger.removeListener).toHaveBeenCalledWith('message', expect.anything());
        expect(wc.debugger.removeListener).toHaveBeenCalledWith('detach', expect.anything());
    });

    test('a failed probe keeps the connection: it only clears the usable flag', async () => {
        // 导航期间探测失败是常态（execution context destroyed），不是连接坏了。
        // 当场 detach 会让每次导航都反复拆连接、丢 CDP 事件；ownership 也不能
        // 无条件清 —— 连接还在却没人记账，dispose 时就再也不会 detach 了。
        const wc = makeWebContents(async () => {
            throw new Error('Execution context was destroyed.');
        }, false);
        const session = await CDPSession.create(wc);
        expect(wc.debugger.isAttached()).toBe(true);

        const waiting = session.waitForPageReady(10);
        await jest.advanceTimersByTimeAsync(1000);
        await waiting;

        expect(session.attached).toBe(false);
        expect(wc.debugger.detach).not.toHaveBeenCalled();

        // 连接仍由本会话持有，dispose 必须负责释放
        session.dispose();
        expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
        expect(wc.debugger.isAttached()).toBe(false);
    });

    test('a failed probe on a connection that is already gone drops the ownership claim', async () => {
        // 连接在外部断掉（没派发 detach 事件）且本会话又探测失败：ownership 要
        // 跟着一起清，否则复用到别人重建的连接后，dispose 会把别人的连接 detach 掉。
        const wc = makeWebContents(async () => {
            throw new Error('Execution context was destroyed.');
        }, false);
        const session = await CDPSession.create(wc);
        wc.debugger.detach();

        const waiting = session.waitForPageReady(10);
        await jest.advanceTimersByTimeAsync(1000);
        await waiting;

        // 别的会话重新 attach 了连接
        wc.debugger.attach();
        wc.debugger.detach.mockClear();
        wc.debugger.attach.mockClear();

        session.dispose();

        expect(wc.debugger.isAttached()).toBe(true);
        expect(wc.debugger.detach).not.toHaveBeenCalled();
    });

    test('a failed probe on a shared attachment leaves the other session s connection alone', async () => {
        // 连接由别的会话持有：探测失败（导航中的常态错误）只清本会话的可用标记，
        // 既不动别人的连接，也不趁机接管。
        const sendCommand = jest.fn<(method: string, params: any) => Promise<any>>(async () => {
            throw new Error('Execution context was destroyed.');
        });
        const wc = makeWebContents(sendCommand, true);
        const session = await CDPSession.create(wc);

        const waiting = session.waitForPageReady(10);
        await jest.advanceTimersByTimeAsync(1000);
        await waiting;

        expect(session.attached).toBe(false);
        expect(wc.debugger.detach).not.toHaveBeenCalled();
        expect(wc.debugger.attach).not.toHaveBeenCalled();
        expect(wc.debugger.isAttached()).toBe(true);

        // 下一次 send 直接复用这条连接
        sendCommand.mockImplementationOnce(async () => ({ result: { value: 2 } }));
        const probe = session.send('Runtime.evaluate', {}, 2000);
        await jest.advanceTimersByTimeAsync(10);
        await expect(probe).resolves.toEqual({ result: { value: 2 } });

        expect(wc.debugger.detach).not.toHaveBeenCalled();
        expect(wc.debugger.attach).not.toHaveBeenCalled();
    });

    test('waitForPageReady returns when every probe wedges (probe-level timeout)', async () => {
        // 单个 Runtime.evaluate 探测永久挂起：deadline 循环必须由单次探测超时接管，
        // 不能无限卡在第一次 sendCommand 上。
        const wc = makeWebContents(() => new Promise(() => undefined));
        const session = await CDPSession.create(wc);

        const waiting = session.waitForPageReady(10000);
        await jest.advanceTimersByTimeAsync(15000);
        await expect(waiting).resolves.toBeUndefined();
    });
});
