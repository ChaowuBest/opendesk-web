import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { BrowserManager, CDPSessionManager } from '../main.js';

afterEach(() => {
    BrowserManager.removeAllControllers();
    BrowserManager.setSessionManagerFactory(undefined);
    BrowserManager.setMainWindow(null);
});

describe('browser host injection', () => {
    test('controllers use isolated host session managers without replacing Electron prototypes', async () => {
        const original = CDPSessionManager.prototype.getSession;
        const created: any[] = [];
        BrowserManager.setSessionManagerFactory(() => {
            const session = { attached: true };
            const manager = { getSession: jest.fn(async () => session), dispose: jest.fn(), disposeAll: jest.fn() };
            created.push(manager);
            return manager;
        });
        const first = BrowserManager.getOrCreateController('one');
        const second = BrowserManager.getOrCreateController('two');
        expect(created).toHaveLength(2);
        expect((first as any)._cdpManager).toBe(created[0]);
        expect((second as any)._cdpManager).toBe(created[1]);
        expect(CDPSessionManager.prototype.getSession).toBe(original);
        BrowserManager.removeController('one');
        expect(created[0].disposeAll).toHaveBeenCalledTimes(1);
        expect(created[1].disposeAll).not.toHaveBeenCalled();
        expect(() => BrowserManager.setSessionManagerFactory(undefined)).toThrow();
    });
    test('a renderer host can serve tabs without claiming a native BrowserWindow', async () => {
        const executeJavaScript = jest.fn(async () => ({ result: [{ id: 1, title: 'tab' }] }));
        BrowserManager.setRendererHost({
            isDestroyed: () => false,
            webContents: { executeJavaScript, send: () => {} }
        });
        expect(BrowserManager.mainWindow).toBeNull();
        const controller = BrowserManager.getOrCreateController('host');
        await expect(controller.tabs('list')).resolves.toEqual({ tabs: [{ id: 1, title: 'tab' }] });
        expect(executeJavaScript).toHaveBeenCalled();
        BrowserManager.setRendererHost(null);
        await expect(controller.tabs('list')).rejects.toThrow();
    });
});
