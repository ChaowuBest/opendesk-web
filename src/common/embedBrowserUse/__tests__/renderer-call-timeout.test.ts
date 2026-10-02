import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { BrowserController, RENDERER_CALL_TIMEOUT_MS } from '../main.js';

/**
 * 回归测试：浏览器桥接调用（executeJavaScript）挂起时不得永久阻塞。
 *
 * 背景：tabs() 等工具通过 callRendererBrowser → webContents.executeJavaScript
 * 调用 renderer。executeJavaScript 在 renderer 忙 / 导航中 / 等待 beforeunload
 * 时可能永不 resolve。此前该调用没有超时，一次挂起会让 controller 的独占锁
 * 队列队头永久卡死，导致该任务后续所有浏览器操作（含 tabs）排队等死——
 * 表现为"tabs 小概率卡死，且同一任务内必现；换新任务才恢复"。
 */
function createController(executeJavaScriptImpl: (...args: unknown[]) => Promise<unknown>) {
    const executeJavaScript = jest.fn<(...args: unknown[]) => Promise<unknown>>(executeJavaScriptImpl);
    const controller = new BrowserController(
        'renderer-call-timeout-test',
        { isDestroyed: () => false, webContents: { executeJavaScript } } as any,
        { beforeCallRenderer: [] }
    );
    return { controller, executeJavaScript };
}

describe('renderer bridge call timeout & queue recovery', () => {
    let disposeSpies: Array<ReturnType<typeof jest.spyOn>> = [];

    beforeEach(() => {
        jest.useFakeTimers();
        disposeSpies = [];
    });

    afterEach(() => {
        for (const spy of disposeSpies) spy.mockRestore();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('tabs(list) rejects with a timeout when the renderer never responds', async () => {
        const { controller } = createController(() => new Promise(() => undefined));

        const rejection = expect(controller.tabs('list')).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(RENDERER_CALL_TIMEOUT_MS);
        await rejection;
    });

    test('after one wedged renderer call, the lock is released and later tabs calls succeed', async () => {
        const { controller, executeJavaScript } = createController(() => new Promise(() => undefined));

        const first = expect(controller.tabs('list')).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(RENDERER_CALL_TIMEOUT_MS);
        await first;

        // Renderer 恢复响应后，同一 controller 的后续调用必须立即可用（不再"必现"）。
        const tabs = [{ id: 1, title: 't', url: 'https://example.com', active: true }];
        executeJavaScript.mockImplementation(async () => ({ result: tabs }));

        const second = controller.tabs('list');
        await jest.advanceTimersByTimeAsync(100);
        await expect(second).resolves.toEqual({ tabs });
    });

    test('a wedged locked operation is cut by the lock watchdog and the queue self-heals', async () => {
        const { controller } = createController(async () => ({ result: 'ok' }));
        const cdpManager = (controller as any)._cdpManager as { disposeAll: ReturnType<typeof jest.fn> };
        const disposeSpy = jest.spyOn(cdpManager, 'disposeAll');
        disposeSpies.push(disposeSpy);

        // 模拟一个内部原语挂死、永不 settle 的锁内操作（如 frame.executeJavaScript 场景）。
        const wedged = expect(
            (controller as any)._withExclusiveLock(() => new Promise(() => undefined), 2000)
        ).rejects.toThrow('卡死超过 2000ms');

        await jest.advanceTimersByTimeAsync(2000);
        await wedged;

        // 自愈：卡死时重置 CDP 会话，避免复用已经坏掉的 debugger 连接。
        expect(disposeSpy).toHaveBeenCalled();

        // 队列仍然可用，后续操作能正常执行。
        await expect((controller as any)._withExclusiveLock(async () => 'recovered', 2000)).resolves.toBe('recovered');
    });

    test('a normal locked operation is not cut by the watchdog', async () => {
        const { controller } = createController(async () => ({ result: 'ok' }));
        const cdpManager = (controller as any)._cdpManager as { disposeAll: ReturnType<typeof jest.fn> };
        const disposeSpy = jest.spyOn(cdpManager, 'disposeAll');
        disposeSpies.push(disposeSpy);

        await expect((controller as any)._withExclusiveLock(async () => 'fine', 2000)).resolves.toBe('fine');

        expect(disposeSpy).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });
});
