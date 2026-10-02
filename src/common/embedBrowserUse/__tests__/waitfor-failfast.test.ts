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

function makeMockSession(isLoading = false) {
    return {
        waitForPageReady: jest.fn(async () => {}),
        waitForDOMStable: jest.fn(async () => {}),
        isHealthy: jest.fn(async () => true),
        webContents: { isLoading: jest.fn(() => isLoading) },
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
        const session = makeMockSession(false /* not loading */);
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            if (expr.includes('chrome-error://')) {
                // Not an error page — no error reported
                return { result: { value: '' } };
            }
            // Text check keeps failing as if the JS context is gone
            throw new Error('Execution context was destroyed');
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
        const session = makeMockSession(true);
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            if (expr.includes('chrome-error://')) {
                return { result: { value: '' } };
            }
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
        const session = makeMockSession();
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
        const session = makeMockSession();
        session.send.mockImplementation(async (_method: string, params: any) => {
            const expr = params.expression as string;
            if (expr.includes('chrome-error://')) {
                return { result: { value: '' } };
            }
            return { result: { value: true } };
        });
        const ctrl = makeController(session);

        const result = await ctrl.waitFor({ text: '目标文本' });
        expect(result).toEqual({ condition: 'text found' });
    });

    it('resolves when the target text disappears', async () => {
        const session = makeMockSession();
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
});
