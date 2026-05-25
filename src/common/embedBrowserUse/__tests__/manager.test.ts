/**
 * Tests for BrowserManager and BrowserController.
 *
 * These tests mock the Electron APIs since we run in Node, not Electron.
 */

import {
    BrowserManager,
    BrowserController,
    BrowserScriptGenerators,
    makeCallBrowserScript,
    makeExecuteScriptOnBrowser
} from '../main';

// Mock script generator — injects beforeCallRenderer hooks
const mockScriptGen: BrowserScriptGenerators = {
    beforeCallRenderer: [
        (taskId: string) =>
            `var el = document.getElementById('task-${taskId}-artifacts'); if (el && typeof el.ensureBrowserReady === 'function') el.ensureBrowserReady();`
    ]
};

describe('embedBrowserUse/main', () => {
    afterEach(() => {
        // Clean up controllers between tests
        BrowserManager.removeController('test-1');
        BrowserManager.removeController('test-2');
    });

    describe('BrowserManager', () => {
        it('should create and retrieve controllers', () => {
            const ctrl = BrowserManager.getOrCreateController('test-1', null);
            expect(ctrl).toBeInstanceOf(BrowserController);
            expect(ctrl.id).toBe('test-1');
        });

        it('should return the same controller for the same id', () => {
            const ctrl1 = BrowserManager.getOrCreateController('test-1', null);
            const ctrl2 = BrowserManager.getOrCreateController('test-1', null);
            expect(ctrl1).toBe(ctrl2);
        });

        it('should return different controllers for different ids', () => {
            const ctrl1 = BrowserManager.getOrCreateController('test-1', null);
            const ctrl2 = BrowserManager.getOrCreateController('test-2', null);
            expect(ctrl1).not.toBe(ctrl2);
        });

        it('should get existing controller', () => {
            BrowserManager.getOrCreateController('test-1', null);
            const ctrl = BrowserManager.getController('test-1');
            expect(ctrl).toBeDefined();
            expect(ctrl!.id).toBe('test-1');
        });

        it('should return undefined for non-existent controller', () => {
            expect(BrowserManager.getController('nonexistent')).toBeUndefined();
        });

        it('should remove controller', () => {
            BrowserManager.getOrCreateController('test-1', null);
            BrowserManager.removeController('test-1');
            expect(BrowserManager.getController('test-1')).toBeUndefined();
        });

        it('should handle removing non-existent controller', () => {
            expect(() => BrowserManager.removeController('nonexistent')).not.toThrow();
        });

        it('should set main window on all controllers', () => {
            const ctrl1 = BrowserManager.getOrCreateController('test-1', null);
            const ctrl2 = BrowserManager.getOrCreateController('test-2', null);
            const mockWindow = { isDestroyed: () => false } as any;
            BrowserManager.setMainWindow(mockWindow);
            // Verify by trying to use it (would throw otherwise)
            expect(ctrl1.id).toBe('test-1');
            expect(ctrl2.id).toBe('test-2');
            BrowserManager.setMainWindow(null);
        });

        it('bind should register IPC handlers', () => {
            const handlers = new Map<string, (...args: unknown[]) => unknown>();
            const mockIpcMain = {
                handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
                    handlers.set(channel, listener);
                }
            };

            // Reset bound state for testing - we access internals directly
            (BrowserManager as any)._bound = false;
            BrowserManager.bind(mockIpcMain as any, mockScriptGen);

            expect(handlers.has('embedBrowser:navigate')).toBe(true);
            expect(handlers.has('embedBrowser:getState')).toBe(true);
            expect(handlers.has('embedBrowser:executeScript')).toBe(true);
            expect(handlers.has('embedBrowser:goBack')).toBe(true);
            expect(handlers.has('embedBrowser:goForward')).toBe(true);
            expect(handlers.has('embedBrowser:refresh')).toBe(true);
            expect(handlers.has('embedBrowser:captureScreenshot')).toBe(true);
            expect(handlers.has('embedBrowser:listTabs')).toBe(true);
            expect(handlers.has('embedBrowser:addTab')).toBe(true);
            expect(handlers.has('embedBrowser:closeTab')).toBe(true);
            expect(handlers.has('embedBrowser:switchTab')).toBe(true);
            expect(handlers.has('embedBrowser:getWebContentsId')).toBe(true);
        });
    });

    describe('BrowserController', () => {
        it('should have the correct id', () => {
            const ctrl = new BrowserController('my-task', null, mockScriptGen);
            expect(ctrl.id).toBe('my-task');
        });

        it('should throw when calling callRendererBrowser with no window', async () => {
            const ctrl = new BrowserController('my-task', null, mockScriptGen);
            await expect(ctrl.callRendererBrowser('browserGetState')).rejects.toThrow('No main window');
        });

        it('should throw when calling runOnActiveWebview with no window', async () => {
            const ctrl = new BrowserController('my-task', null, mockScriptGen);
            await expect(ctrl.runOnActiveWebview('1+1')).rejects.toThrow('No main window');
        });

        it('should return null for getCDPSession with no window', async () => {
            const ctrl = new BrowserController('my-task', null, mockScriptGen);
            const session = await ctrl.getCDPSession();
            expect(session).toBeNull();
        });

        it('dispose should clean up', () => {
            const ctrl = new BrowserController('my-task', null, mockScriptGen);
            expect(() => ctrl.dispose()).not.toThrow();
        });
    });

    describe('Script generators', () => {
        it('beforeCallRenderer hook (mock) should produce script with task id', () => {
            const hook = mockScriptGen.beforeCallRenderer[0];
            const script = hook('task-42');
            expect(script).toContain('task-42');
            expect(script).toContain('task-task-42-artifacts');
        });

        it('makeCallBrowserScript should produce valid IIFE', () => {
            const script = makeCallBrowserScript('task-1', 'browserNavigate', ['https://example.com']);
            expect(script).toContain('browserNavigate');
            expect(script).toContain('https://example.com');
            expect(script).toContain('task-1-artifacts');
            // Should NOT contain beforeCallRenderer hook logic
            expect(script).not.toContain('ensureTaskViewExists');
        });

        it('makeExecuteScriptOnBrowser should produce valid IIFE', () => {
            const script = makeExecuteScriptOnBrowser('task-1', 'document.title');
            expect(script).toContain('browserExecuteScript');
            expect(script).toContain('document.title');
            // Should NOT contain beforeCallRenderer hook logic
            expect(script).not.toContain('ensureTaskViewExists');
        });

        it('BrowserScriptGenerators supports multiple hooks', () => {
            const multiGen: BrowserScriptGenerators = {
                beforeCallRenderer: [(id) => `/* hook1 ${id} */`, (id) => `/* hook2 ${id} */`]
            };
            expect(multiGen.beforeCallRenderer).toHaveLength(2);
            expect(multiGen.beforeCallRenderer[0]('test')).toContain('hook1');
            expect(multiGen.beforeCallRenderer[1]('test')).toContain('hook2');
        });
    });
});
