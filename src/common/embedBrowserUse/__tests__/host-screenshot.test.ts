import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { BrowserController, BrowserManager, type BrowserRendererHost } from '../main.js';
import { Channels } from '../protocol.js';

const PNG_URI = 'data:image/png;base64,aG9zdC1wbmc=';
const JPEG_URI = 'data:image/jpeg;base64,aG9zdC1qcGVn';
let allowElectron = false;
const electronImported = jest.fn();
const fromId = jest.fn<(...args: unknown[]) => any>();
const capturePage = jest.fn<() => Promise<any>>();
const toPNG = jest.fn(() => Buffer.from('native-png'));
const toJPEG = jest.fn(() => Buffer.from('native-jpeg'));
const nativeImage = { isEmpty: () => false, toPNG, toJPEG };

jest.unstable_mockModule('electron', () => {
    electronImported();
    if (!allowElectron) throw new Error('Electron must not be loaded for host screenshots');
    return { webContents: { fromId } };
});

function createHost(
    captureBrowserScreenshot?: (...args: any[]) => Promise<string | null>,
    webContentsId: number | null = 7
) {
    return {
        isDestroyed: () => false,
        webContents: {
            executeJavaScript: jest.fn(async () => (webContentsId === null ? null : { result: webContentsId })),
            send: jest.fn()
        },
        captureBrowserScreenshot
    } as BrowserRendererHost;
}

function bindCapture(host: BrowserRendererHost) {
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    BrowserManager.setRendererHost(host);
    BrowserManager.bind({ handle: (channel, listener) => handlers.set(channel, listener) });
    return handlers.get(Channels.captureScreenshot)!;
}

beforeEach(() => {
    jest.clearAllMocks();
    allowElectron = false;
    (BrowserManager as any)._bound = false;
    fromId.mockReturnValue({ isDestroyed: () => false, capturePage });
    capturePage.mockResolvedValue(nativeImage);
});

afterEach(() => {
    BrowserManager.removeAllControllers();
    BrowserManager.setMainWindow(null);
    (BrowserManager as any)._bound = false;
    jest.useRealTimers();
});

describe('host screenshot capability without Electron', () => {
    test('the real controller requests the active guest as PNG through its host', async () => {
        const capture = jest.fn(async () => PNG_URI);
        const host = createHost(capture);
        BrowserManager.setRendererHost(host);
        const controller = BrowserManager.getOrCreateController('host-screenshot');

        await expect(controller.captureScreenshot()).resolves.toBe(PNG_URI);

        expect(host.webContents.executeJavaScript).toHaveBeenCalled();
        expect(capture).toHaveBeenCalledWith(7, { format: 'png' });
        expect(electronImported).not.toHaveBeenCalled();
    });

    test('the real screenshot IPC requests JPEG quality 70 through the same host port', async () => {
        const capture = jest.fn(async () => JPEG_URI);
        const handler = bindCapture(createHost(capture));

        await expect(handler(undefined, 9)).resolves.toEqual({ status: 'ok', data: JPEG_URI });

        expect(capture).toHaveBeenCalledWith(9, { format: 'jpeg', quality: 70 });
        expect(electronImported).not.toHaveBeenCalled();
    });

    test('a host failure propagates without trying the Electron backend', async () => {
        const capture = jest.fn(async () => {
            throw new Error('host capture failed');
        });
        const controller = new BrowserController('host-failure', createHost(capture));

        await expect(controller.captureScreenshot()).rejects.toThrow('host capture failed');

        expect(capture).toHaveBeenCalledTimes(1);
        expect(electronImported).not.toHaveBeenCalled();
    });

    test.each([null, ''])(
        'an empty host capture (%s) fails without trying the Electron backend',
        async (emptyResult) => {
            const capture = jest.fn(async () => emptyResult);
            const controller = new BrowserController('host-empty', createHost(capture));

            await expect(controller.captureScreenshot()).rejects.toThrow('Empty capture');

            expect(capture).toHaveBeenCalledTimes(1);
            expect(electronImported).not.toHaveBeenCalled();
        }
    );

    test('screenshot IPC retains the error envelope for a host failure', async () => {
        const capture = jest.fn(async () => {
            throw new Error('host capture failed');
        });
        const handler = bindCapture(createHost(capture));

        await expect(handler(undefined, 9)).resolves.toEqual({
            status: 'error',
            message: 'Error: host capture failed'
        });

        expect(electronImported).not.toHaveBeenCalled();
    });

    test('a missing active tab never invokes a screenshot backend', async () => {
        const capture = jest.fn(async () => PNG_URI);
        const controller = new BrowserController('host-no-tab', createHost(capture, null));

        await expect(controller.captureScreenshot()).rejects.toThrow('No active browser tab to capture');

        expect(capture).not.toHaveBeenCalled();
        expect(electronImported).not.toHaveBeenCalled();
    });
});

describe('default Electron screenshot capability', () => {
    beforeEach(() => {
        allowElectron = true;
    });

    test('the controller still captures native PNG without attaching CDP', async () => {
        const controller = new BrowserController('native-png', createHost());

        await expect(controller.captureScreenshot()).resolves.toBe(
            `data:image/png;base64,${Buffer.from('native-png').toString('base64')}`
        );

        expect(fromId).toHaveBeenCalledWith(7);
        expect(capturePage).toHaveBeenCalledTimes(1);
        expect(toPNG).toHaveBeenCalledTimes(1);
        expect(toJPEG).not.toHaveBeenCalled();
    });

    test('screenshot IPC still captures native JPEG quality 70', async () => {
        const handler = bindCapture(createHost());

        await expect(handler(undefined, 9)).resolves.toEqual({
            status: 'ok',
            data: `data:image/jpeg;base64,${Buffer.from('native-jpeg').toString('base64')}`
        });

        expect(fromId).toHaveBeenCalledWith(9);
        expect(toJPEG).toHaveBeenCalledWith(70);
        expect(toPNG).not.toHaveBeenCalled();
    });

    test('native captures retry empty compositor frames before succeeding', async () => {
        jest.useFakeTimers();
        capturePage.mockResolvedValueOnce({ isEmpty: () => true }).mockResolvedValueOnce({ isEmpty: () => true });
        const controller = new BrowserController('native-retry', createHost());
        const screenshot = controller.captureScreenshot();
        const result = expect(screenshot).resolves.toContain('data:image/png;base64,');

        await jest.advanceTimersByTimeAsync(900);
        await result;

        expect(capturePage).toHaveBeenCalledTimes(3);
    });

    test('destroyed native tabs retain their error envelope', async () => {
        fromId.mockReturnValue({ isDestroyed: () => true });
        const handler = bindCapture(createHost());

        await expect(handler(undefined, 9)).resolves.toEqual({
            status: 'error',
            message: 'WebContents not found or destroyed'
        });

        expect(capturePage).not.toHaveBeenCalled();
    });

    test.each(['controller', 'ipc'])('the native %s reports Empty capture after bounded retries', async (path) => {
        jest.useFakeTimers();
        capturePage.mockResolvedValue({ isEmpty: () => true });
        const controller = new BrowserController('native-empty', createHost());
        const screenshot =
            path === 'controller'
                ? expect(controller.captureScreenshot()).rejects.toThrow('Empty capture')
                : expect(bindCapture(createHost())(undefined, 9)).resolves.toEqual({
                      status: 'error',
                      message: 'Error: Empty capture'
                  });

        await jest.advanceTimersByTimeAsync(900);
        await screenshot;

        expect(capturePage).toHaveBeenCalledTimes(3);
    });
});
