/**
 * Tests for navigate DOM-stable waiting.
 *
 * SPA pages render their main content asynchronously after the JS context
 * becomes ready. navigate() must wait for the DOM to settle before returning,
 * otherwise an auto-snapshot taken right after navigation captures a page
 * whose dynamic content has not been rendered yet.
 */

import { BrowserController, BrowserScriptGenerators } from '../main';
import { jest } from '@jest/globals';

function makeMockSession() {
    return {
        waitForPageReady: jest.fn(async () => {}),
        waitForDOMStable: jest.fn(async () => {}),
        send: jest.fn(async () => ({
            result: { value: JSON.stringify({ url: 'https://example.com/hello', title: 'Example' }) }
        })),
        isHealthy: jest.fn(async () => true)
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
    const ctrl = new BrowserController('nav-dom-stable-test', mockWindow as any, scriptGen);
    (ctrl as any).getCDPSession = jest.fn(async () => session);
    return ctrl;
}

describe('navigate DOM-stable wait', () => {
    it('should wait for DOM stable on the CDP session before resolving', async () => {
        const session = makeMockSession();
        const ctrl = makeController(session);

        const result = await ctrl.navigate('https://example.com/hello', false);

        expect(result.error).toBeUndefined();
        expect(result.url).toBe('https://example.com/hello');
        expect(session.waitForPageReady).toHaveBeenCalled();

        // The actual regression guard: navigate must give async-rendered SPA
        // content a chance to settle instead of returning immediately after
        // the JS context is ready.
        expect(session.waitForDOMStable).toHaveBeenCalled();
    });

    it('should keep the overall navigate budget under NAVIGATE_TIMEOUT', async () => {
        // waitForPageReady(15000) + waitForDOMStable(3000) + sleeps must stay
        // below the 20s race timeout so slow-but-viable pages are not rejected
        // just because we added the DOM-stable wait.
        const session = makeMockSession();
        let readyTimeoutArg = 0;
        session.waitForPageReady.mockImplementation(async (timeoutMs: number) => {
            readyTimeoutArg = timeoutMs;
        });
        let stableTimeoutArg = 0;
        session.waitForDOMStable.mockImplementation(async (timeoutMs?: number) => {
            stableTimeoutArg = timeoutMs ?? 0;
        });
        const ctrl = makeController(session);

        await ctrl.navigate('https://example.com/hello', false);

        // Mirrors internal constants: sleep(400) + sleep(200) around the waits.
        const totalBudget = 400 + readyTimeoutArg + stableTimeoutArg + 200;
        expect(totalBudget).toBeLessThan(20000);
    });
});
