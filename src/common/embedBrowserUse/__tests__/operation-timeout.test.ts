import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { BrowserController } from '../main.js';

function createController() {
    const executeJavaScript = jest.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ result: 'done' }));
    const session = {
        waitForPageReady: jest.fn<() => Promise<void>>(async () => undefined),
        waitForDOMStable: jest.fn(async () => undefined),
        send: jest.fn(async () => ({
            result: { value: JSON.stringify({ url: 'https://example.com', title: 'Example' }) }
        }))
    };
    const controller = new BrowserController(
        'timeout-cleanup-test',
        { isDestroyed: () => false, webContents: { executeJavaScript } } as any,
        { beforeCallRenderer: [] }
    );
    jest.spyOn(controller, 'getCDPSession').mockResolvedValue(session as any);
    return { controller, executeJavaScript, session };
}

describe('browser operation timeout cleanup', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('clears the navigation timeout after success', async () => {
        const { controller } = createController();
        const navigation = controller.navigate('https://example.com');
        await jest.advanceTimersByTimeAsync(600);

        await expect(navigation).resolves.toEqual({ url: 'https://example.com', title: 'Example' });
        expect(jest.getTimerCount()).toBe(0);
    });

    test('clears the navigation timeout after a page error', async () => {
        const { controller, session } = createController();
        session.waitForPageReady.mockRejectedValueOnce(new Error('page failed'));
        const rejection = expect(controller.navigate('https://example.com')).rejects.toThrow('page failed');
        await jest.advanceTimersByTimeAsync(400);

        await rejection;
        expect(jest.getTimerCount()).toBe(0);
    });

    test('still rejects navigation that exceeds the timeout', async () => {
        const { controller, session } = createController();
        session.waitForPageReady.mockImplementationOnce(() => new Promise(() => undefined));
        const rejection = expect(controller.navigate('https://example.com')).rejects.toThrow('导航超时');
        await jest.advanceTimersByTimeAsync(20000);

        await rejection;
        expect(jest.getTimerCount()).toBe(0);
    });

    test('clears the script timeout after success', async () => {
        const { controller } = createController();

        await expect(controller.runOnActiveWebview('1 + 1')).resolves.toBe('done');
        expect(jest.getTimerCount()).toBe(0);
    });

    test('clears the script timeout after an execution error', async () => {
        const { controller, executeJavaScript } = createController();
        executeJavaScript.mockRejectedValueOnce(new Error('script failed'));

        await expect(controller.runOnActiveWebview('throw new Error()')).rejects.toThrow('script failed');
        expect(jest.getTimerCount()).toBe(0);
    });

    test('still rejects a script that exceeds the timeout', async () => {
        const { controller, executeJavaScript } = createController();
        executeJavaScript.mockImplementationOnce(() => new Promise(() => undefined));
        const rejection = expect(controller.runOnActiveWebview('pending', 100)).rejects.toThrow('timed out');
        await jest.advanceTimersByTimeAsync(100);

        await rejection;
        expect(jest.getTimerCount()).toBe(0);
    });
});
