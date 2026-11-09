/**
 * Tests for waitFor fail-fast behavior.
 *
 * waitFor must not blindly poll until timeout when the page has actually
 * failed: a Chromium error page (chrome-error://) can never satisfy a text
 * condition, and an execution context that keeps failing (crashed tab /
 * detached target) should give up instead of silently retrying forever.
 */

import { BrowserController, BrowserScriptGenerators } from '../main';
import { jest } from '@jest/globals';

function makeMockSession(isLoading = false, mainFrameTextCheck: () => Promise<boolean> = async () => false) {
    return {
        waitForPageReady: jest.fn(async () => {}),
        waitForDOMStable: jest.fn(async () => {}),
        isHealthy: jest.fn(async () => true),
        webContents: {
            isLoading: jest.fn(() => isLoading),
            isDestroyed: jest.fn(() => false),
            // waitFor（无 iframeRef）的文本检测已覆盖全部 frame（BUG-28 修复），
            // 主 frame 走 WebFrameMain.executeJavaScript 而非 Runtime.evaluate
            mainFrame: {
                url: 'https://example.com/',
                frames: [],
                executeJavaScript: jest.fn(mainFrameTextCheck)
            }
        },
        send: jest.fn()
    };
}

function makeController(session: ReturnType<typeof makeMockSession>) {
    const mockWindow = {
        isDestroyed: () => false,
        webContents: {
            executeJavaScript: jest.fn(async () => ({}))
        }
    };
    const scriptGen: BrowserScriptGenerators = { beforeCallRenderer: [] };
    const ctrl = new BrowserController('waitfor-failfast-test', mockWindow as any, scriptGen);
    (ctrl as any).getCDPSession = jest.fn(async () => session);
    return ctrl;
}

describe('waitFor fail-fast', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('fails immediately with the error code on a chrome error page', async () => {
        jest.useFakeTimers();
        const session = makeMockSession();
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            // detectChromeError expression — report ERR_NAME_NOT_RESOLVED
            if (expr.includes('chrome-error://')) {
                return {
                    result: {
                        value: JSON.stringify({
                            code: 'ERR_NAME_NOT_RESOLVED',
                            details: 'example.com 的服务器 IP 地址无法找到。'
                        })
                    }
                };
            }
            // text condition — never satisfied
            return { result: { value: false } };
        });
        const ctrl = makeController(session);

        const promise = ctrl.waitFor({ text: '目标文本' });
        // Must reject on the first poll without advancing any timers.
        await expect(promise).rejects.toThrow('页面加载失败：ERR_NAME_NOT_RESOLVED');
    });

    it('gives up after the execution context keeps failing across polls', async () => {
        jest.useFakeTimers();
        const session = makeMockSession(false /* not loading */, async () => {
            throw new Error('Execution context was destroyed');
        });
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            if (expr.includes('chrome-error://')) {
                // Not an error page — no error reported
                return { result: { value: '' } };
            }
            throw new Error('unexpected Runtime.evaluate');
        });
        const ctrl = makeController(session);

        const promise = ctrl.waitFor({ text: '目标文本' });
        // Round 1 fails (count=1) → sleep 400 → round 2 (count=2) → sleep 400
        // → round 3 (count=3) → reject. Attach the rejection handler before
        // advancing timers to avoid an unhandled rejection.
        const rejection = expect(promise).rejects.toThrow('页面执行环境异常');
        await jest.advanceTimersByTimeAsync(400 * 2 + 100);
        await rejection;
    });

    it('does not count evaluate failures while the page is still loading', async () => {
        jest.useFakeTimers();
        // Page keeps navigating the whole time — evaluate failures are the
        // expected transient state and must never trip the crash guard.
        const session = makeMockSession(true, async () => {
            throw new Error('Execution context was destroyed');
        });
        const ctrl = makeController(session);

        const promise = ctrl.waitFor({ text: '目标文本' });
        // Even with many failing polls, the wait must end in a plain timeout
        // instead of a context error — a slow navigation is not a crash.
        const rejection = expect(promise).rejects.toThrow('等待超时（3秒）');
        await jest.advanceTimersByTimeAsync(3200 + 100);
        await rejection;
        expect(session.webContents.isLoading).toHaveBeenCalled();
    });

    it('uses a 3-second default timeout', async () => {
        jest.useFakeTimers();
        const session = makeMockSession(false, async () => false);
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            if (expr.includes('chrome-error://')) {
                return { result: { value: '' } };
            }
            return { result: { value: false } };
        });
        const ctrl = makeController(session);

        const promise = ctrl.waitFor({ text: '永不出现的文本' });
        // Default deadline is 3s; the last poll exits the loop after 3200ms.
        const rejection = expect(promise).rejects.toThrow('等待超时（3秒）');
        await jest.advanceTimersByTimeAsync(3200 + 100);
        await rejection;
    });

    it('resolves when the target text appears', async () => {
        const session = makeMockSession(false, async () => true);
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            if (expr.includes('chrome-error://')) {
                return { result: { value: '' } };
            }
            throw new Error('unexpected Runtime.evaluate');
        });
        const ctrl = makeController(session);

        const result = await ctrl.waitFor({ text: '目标文本' });
        expect(result).toEqual({ condition: 'text found' });
    });

    it('resolves when the target text disappears', async () => {
        const session = makeMockSession(false, async () => false);
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            if (expr.includes('chrome-error://')) {
                return { result: { value: '' } };
            }
            // textGone: the text is gone as soon as it is not found
            return { result: { value: false } };
        });
        const ctrl = makeController(session);

        const result = await ctrl.waitFor({ textGone: '加载中' });
        expect(result).toEqual({ condition: 'text gone' });
    });

    it('does not trip the crash guard for failing iframe checks', async () => {
        jest.useFakeTimers();
        const session = makeMockSession(false);
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            if (expr.includes('chrome-error://')) {
                return { result: { value: '' } };
            }
            throw new Error('unexpected main-frame text check');
        });
        // Build a real (fake) frame tree so navigateIntoFrame resolves through
        // its actual implementation: main frame exposes an iframe descriptor to
        // findChildFrame, and the child frame keeps failing its text checks.
        const fakeFrame = {
            url: 'https://example.com/iframe',
            executeJavaScript: jest.fn(async () => {
                throw new Error('frame gone');
            })
        };
        const fakeMainFrame = {
            url: 'https://example.com/main',
            frames: [fakeFrame],
            executeJavaScript: jest.fn(async () => ({ index: 0, src: 'https://example.com/iframe' }))
        };
        session.webContents.mainFrame = fakeMainFrame;
        const ctrl = makeController(session);

        const promise = ctrl.waitFor({ text: '目标文本', iframeRef: 'e3' });
        const rejection = expect(promise).rejects.toThrow('等待超时（3秒）');
        await jest.advanceTimersByTimeAsync(3200 + 100);
        await rejection;
    });

    it('bounds every poll by the remaining deadline budget (wedged CDP, 1s timeout)', async () => {
        jest.useFakeTimers();
        const session = makeMockSession(false);
        // Simulate a wedged CDP connection: every command hangs until its own
        // timeout fires. Without the per-poll remaining-budget clamp a 1s wait
        // would burn 2×1s + 0.4s sleep in a single poll (~2.4s total).
        session.send.mockImplementation(async (_method: string, _params: any, timeoutMs: number = 1500) => {
            await new Promise((r) => setTimeout(r, timeoutMs));
            throw new Error('CDP command timed out');
        });
        const ctrl = makeController(session);

        const promise = ctrl.waitFor({ text: '目标文本', timeout: 1 });
        let settled = false;
        promise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );
        // At t≈1s the wait must already have finished — a pre-fix implementation
        // would still be stuck inside the first poll.
        await jest.advanceTimersByTimeAsync(1000 + 100);
        expect(settled).toBe(true);
        // Settle the promise chain so no unhandled rejection leaks after the test.
        await promise.catch(() => undefined);
    });

    it('bounds multi-frame text checks by the overall deadline (hung child frames)', async () => {
        jest.useFakeTimers();
        const session = makeMockSession(false);
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            if (expr.includes('chrome-error://')) {
                return { result: { value: '' } };
            }
            throw new Error('unexpected Runtime.evaluate');
        });
        // 主 frame 立即返回 false；两个子 frame 的 executeJavaScript 挂死。
        // 每个 frame 的预算从 poll 截止时间逐 frame 重算：第一个 hung frame
        // 耗尽预算后，后续 frame 不得再获得新的完整预算，否则单次 poll 就会
        // 超出 waitFor 的总 deadline（1s 变 2s+）。
        const hangingChild = (name: string) => ({
            url: `https://example.com/${name}`,
            frames: [],
            executeJavaScript: jest.fn(() => new Promise<boolean>(() => {}))
        });
        const fakeMainFrame = {
            url: 'https://example.com/main',
            frames: [hangingChild('a'), hangingChild('b')],
            executeJavaScript: jest.fn(async () => false)
        };
        session.webContents.mainFrame = fakeMainFrame;
        const ctrl = makeController(session);

        const promise = ctrl.waitFor({ text: '目标文本', timeout: 1 });
        let settled = false;
        promise.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );
        // 第一个子 frame 挂到 ~1s（预算上限），第二个子 frame 必须因预算耗尽被
        // 跳过 —— t≈1.15s 时整个 waitFor 必须已按超时结束。
        await jest.advanceTimersByTimeAsync(1000 + 150);
        expect(settled).toBe(true);
        await promise.catch(() => undefined);
    });
});
