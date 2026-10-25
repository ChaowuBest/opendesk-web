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
function makeWebContents(sendCommandImpl: (method: string, params: any) => Promise<any>) {
    let attachedFlag = true;
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
        const wc = makeWebContents(() => new Promise(() => undefined));
        const session = await CDPSession.create(wc);

        const rejection = expect(session.send('Runtime.evaluate', {}, 2000)).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(2000);
        await rejection;

        expect(wc.debugger.detach).toHaveBeenCalled();
        expect(session.attached).toBe(false);
    });

    test('a timed-out session recovers: the next send re-attaches and works', async () => {
        const sendCommand = jest.fn<(method: string, params: any) => Promise<any>>(() => new Promise(() => undefined));
        const wc = makeWebContents(sendCommand);
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
