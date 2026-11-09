import { describe, expect, jest, test } from '@jest/globals';
import { CDPSession } from '../cdp/session.js';

/**
 * 回归测试：JS 对话框自动接管（BUG-02）。
 *
 * 背景：iframe 内触发 confirm() 时，在途的 WebFrameMain.executeJavaScript 会
 * 被对话框挂起，直到独占锁看门狗 180s 超时并重置整个浏览器会话。CDP 会话必须
 * 在可触发对话框的操作前 enable Page 域，收到 Page.javascriptDialogOpening 后
 * 立即应答 handleJavaScriptDialog，让挂起的执行得以继续。
 */
function makeWebContents(sendCommandImpl: (method: string, params: any) => Promise<any>) {
    return {
        id: 7,
        isDestroyed: () => false,
        debugger: {
            isAttached: () => true,
            attach: jest.fn(),
            detach: jest.fn(),
            on: jest.fn(),
            removeListener: jest.fn(),
            sendCommand: jest.fn(sendCommandImpl)
        }
    } as any;
}

/** 从 debugger.on 的注册里取出 message 事件分发器（模拟 Electron 派发 CDP 事件）。 */
function messageDispatcher(wc: any): (method: string, params: any) => void {
    const handler = wc.debugger.on.mock.calls.find(([event]: any[]) => event === 'message')?.[1];
    if (!handler) throw new Error('message listener not registered');
    return (method: string, params: any) => handler({}, method, params);
}

describe('CDPSession JS dialog handling', () => {
    test('ensureDialogHandling enables the Page domain once per connection', async () => {
        const wc = makeWebContents(async () => ({}));
        const session = await CDPSession.create(wc);

        await session.ensureDialogHandling();
        await session.ensureDialogHandling();

        const enableCalls = wc.debugger.sendCommand.mock.calls.filter(([m]: any[]) => m === 'Page.enable');
        expect(enableCalls).toHaveLength(1);
    });

    test('a dialog opening is answered with handleJavaScriptDialog(accept=true) and recorded', async () => {
        const wc = makeWebContents(async () => ({}));
        const session = await CDPSession.create(wc);
        await session.ensureDialogHandling();
        wc.debugger.sendCommand.mockClear();

        const dispatch = messageDispatcher(wc);
        dispatch('Page.javascriptDialogOpening', {
            type: 'confirm',
            message: 'LEAVE-PAGE?',
            url: 'http://127.0.0.1:8787/frame-basic.html'
        });

        // 事件处理器内异步应答，让微任务跑完
        await Promise.resolve();
        await Promise.resolve();

        const handled = wc.debugger.sendCommand.mock.calls.filter(([m]: any[]) => m === 'Page.handleJavaScriptDialog');
        expect(handled).toHaveLength(1);
        expect(handled[0][1]).toEqual({ accept: true });

        expect(session.takeLastDialog()).toEqual({
            type: 'confirm',
            message: 'LEAVE-PAGE?',
            url: 'http://127.0.0.1:8787/frame-basic.html'
        });
        // 取出后清空，不会重复回显
        expect(session.takeLastDialog()).toBeNull();
    });

    test('dialog info is cleared on dispose-safe paths and takeLastDialog starts empty', async () => {
        const wc = makeWebContents(async () => ({}));
        const session = await CDPSession.create(wc);

        expect(session.takeLastDialog()).toBeNull();
    });

    test('Page.enable failure does not throw and leaves the session usable', async () => {
        const wc = makeWebContents(async (method: string) => {
            if (method === 'Page.enable') throw new Error('Page domain not supported');
            return {};
        });
        const session = await CDPSession.create(wc);

        await expect(session.ensureDialogHandling()).resolves.toBeUndefined();
        // 其余命令仍可正常发送
        await expect(session.send('Runtime.evaluate', { expression: '1' })).resolves.toBeDefined();
    });
});
