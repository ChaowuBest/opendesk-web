import { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import type { ServerMessage } from '../../../common/web/protocol.js';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpcMain extends EventEmitter {
    readonly registered = new Map<string, Handler>();
    handle(channel: string, handler: Handler): void {
        if (this.registered.has(channel)) throw new Error(`second handler for ${channel}`);
        this.registered.set(channel, handler);
    }
    handleOnce(channel: string, handler: Handler): void {
        this.registered.set(channel, handler);
    }
    removeHandler(channel: string): void {
        this.registered.delete(channel);
    }
}

class FakeBrowserWindow {
    webContents = {
        send: jest.fn(),
        mainFrame: { send: jest.fn() }
    };
}

const ipcMain = new FakeIpcMain();
const dialog: Record<string, unknown> = {};
const shell: Record<string, unknown> = {};

jest.unstable_mockModule('electron', () => ({ ipcMain, dialog, shell, BrowserWindow: FakeBrowserWindow }));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

let bridge: typeof import('../../../main/web/ipc-bridge.js');
let codec: typeof import('../../../common/web/ipc-codec.js');

function createClient(url = 'http://localhost/index.html') {
    const sent: ServerMessage[] = [];
    const client = new bridge.WebIpcClient((message) => sent.push(message), url);
    return { client, sent };
}

function events(sent: ServerMessage[]) {
    return sent
        .filter((m): m is Extract<ServerMessage, { t: 'evt' }> => m.t === 'evt')
        .map((m) => ({ ch: m.ch, args: codec.decodeIpcValue(m.a) }));
}

beforeAll(async () => {
    bridge = await import('../../../main/web/ipc-bridge.js');
    codec = await import('../../../common/web/ipc-codec.js');
    bridge.installIpcRecorder();
});

describe('web ipc bridge', () => {
    test('records handlers while keeping the original registration', async () => {
        ipcMain.handle('test:echo', (_event, a, b) => ({ a, b }));
        expect(ipcMain.registered.has('test:echo')).toBe(true);
        expect(() => ipcMain.handle('test:echo', () => null)).toThrow('second handler');

        const { client } = createClient();
        await expect(bridge.dispatchInvoke(client, 'test:echo', [1, 'x'])).resolves.toEqual({ a: 1, b: 'x' });
    });

    test('handlers see the browser connection as sender and main frame', async () => {
        let seen: { sender: unknown; senderFrame: unknown } | undefined;
        ipcMain.handle('test:sender', (event) => {
            seen = event as typeof seen;
            const sender = (event as { sender: { send: (...a: unknown[]) => void } }).sender;
            sender.send('test:pushed', 42);
        });
        const { client, sent } = createClient('http://host/index.html');
        await bridge.dispatchInvoke(client, 'test:sender', []);

        expect(seen?.sender).toBe(client);
        expect(seen?.senderFrame).toBe(client.mainFrame);
        expect(client.mainFrame.url).toBe('http://host/index.html');
        expect(events(sent)).toEqual([{ ch: 'test:pushed', args: [42] }]);
    });

    test('per-frame pushes only reach the subscribing connection', async () => {
        ipcMain.handle('test:subscribe', (event) => {
            const frame = (event as { senderFrame: { send: (...a: unknown[]) => void } }).senderFrame;
            frame.send('test:update', 'for-me');
        });
        const a = createClient();
        const b = createClient();
        await bridge.dispatchInvoke(a.client, 'test:subscribe', []);
        expect(events(a.sent)).toEqual([{ ch: 'test:update', args: ['for-me'] }]);
        expect(events(b.sent)).toEqual([]);
    });

    test('waits for handlers registered after the browser connected', async () => {
        const { client } = createClient();
        const pending = bridge.dispatchInvoke(client, 'test:late', ['v']);
        ipcMain.handle('test:late', (_event, value) => `late-${value}`);
        await expect(pending).resolves.toBe('late-v');
    });

    test('ipcRenderer.send reaches ipcMain.on listeners with a reply helper', () => {
        const { client, sent } = createClient();
        ipcMain.on('test:fire', (event: { sender: unknown; reply: (...a: unknown[]) => void }, value: unknown) => {
            expect(event.sender).toBe(client);
            event.reply('test:fired', value);
        });
        bridge.dispatchSend(client, 'test:fire', ['ping']);
        expect(events(sent)).toEqual([{ ch: 'test:fired', args: ['ping'] }]);
    });

    test('native dialogs are answered by the connection that triggered the IPC', async () => {
        ipcMain.handle('test:pick', async () => {
            const showOpenDialog = dialog.showOpenDialog as (...a: unknown[]) => Promise<unknown>;
            return showOpenDialog(new FakeBrowserWindow(), { properties: ['openFile'], title: 'Pick' });
        });
        const { client, sent } = createClient();
        const other = createClient();
        other.client.markActive();

        const result = bridge.dispatchInvoke(client, 'test:pick', []);
        await new Promise((resolve) => setImmediate(resolve));
        const request = sent.find((m): m is Extract<ServerMessage, { t: 'req' }> => m.t === 'req');
        expect(request?.kind).toBe('openDialog');
        expect(codec.decodeIpcValue(request?.p)).toEqual({ properties: ['openFile'], title: 'Pick' });
        expect(other.sent.some((m) => m.t === 'req')).toBe(false);

        client.resolveRequest(request!.id, ['/tmp/a.txt']);
        await expect(result).resolves.toEqual({ canceled: false, filePaths: ['/tmp/a.txt'] });
    });

    test('a dialog is reported as canceled when its connection closes', async () => {
        ipcMain.handle('test:save', () => (dialog.showSaveDialog as (...a: unknown[]) => Promise<unknown>)({}));
        const { client } = createClient();
        const result = bridge.dispatchInvoke(client, 'test:save', []);
        await new Promise((resolve) => setImmediate(resolve));
        client.destroy();
        await expect(result).resolves.toEqual({ canceled: true, filePath: '' });
    });

    test('shell.openPath opens the file through the web file route', async () => {
        const { client, sent } = createClient();
        client.markActive();
        await (shell.openPath as (p: string) => Promise<string>)('/tmp/dir with space/a#b.txt');
        expect(sent).toContainEqual({ t: 'open', url: '/__opendesk/fs/tmp/dir%20with%20space/a%23b.txt' });
    });

    test('messages sent to the hidden main window are broadcast to every connection', () => {
        const win = new FakeBrowserWindow();
        bridge.attachHiddenMainWindow(win as never);
        const a = createClient();
        const b = createClient();
        win.webContents.send('applicationRegistry:changed', ['app']);
        expect(events(a.sent)).toEqual([{ ch: 'applicationRegistry:changed', args: [['app']] }]);
        expect(events(b.sent)).toEqual([{ ch: 'applicationRegistry:changed', args: [['app']] }]);
    });

    test('destroyed connections emit destroyed and stop receiving messages', () => {
        const { client, sent } = createClient();
        const onDestroyed = jest.fn();
        client.on('destroyed', onDestroyed);
        client.destroy();
        expect(onDestroyed).toHaveBeenCalledTimes(1);
        expect(client.isDestroyed()).toBe(true);
        expect(client.mainFrame.isDestroyed()).toBe(true);
        client.send('test:after', 1);
        expect(sent).toEqual([]);
    });
});
