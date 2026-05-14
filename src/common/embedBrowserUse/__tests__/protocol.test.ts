import { Channels } from '../protocol';
import type { BrowserState, TabInfo, PageSnapshot, IPCResponse, BrowserBridgeAPI } from '../protocol';

describe('embedBrowserUse/protocol', () => {
    describe('Channels', () => {
        it('should have all expected channel names', () => {
            expect(Channels.navigate).toBe('embedBrowser:navigate');
            expect(Channels.getState).toBe('embedBrowser:getState');
            expect(Channels.executeScript).toBe('embedBrowser:executeScript');
            expect(Channels.goBack).toBe('embedBrowser:goBack');
            expect(Channels.goForward).toBe('embedBrowser:goForward');
            expect(Channels.refresh).toBe('embedBrowser:refresh');
            expect(Channels.captureScreenshot).toBe('embedBrowser:captureScreenshot');
            expect(Channels.listTabs).toBe('embedBrowser:listTabs');
            expect(Channels.addTab).toBe('embedBrowser:addTab');
            expect(Channels.closeTab).toBe('embedBrowser:closeTab');
            expect(Channels.switchTab).toBe('embedBrowser:switchTab');
            expect(Channels.getWebContentsId).toBe('embedBrowser:getWebContentsId');
            expect(Channels.popupBlocked).toBe('embedBrowser:popup-blocked');
        });

        it('should have unique channel names', () => {
            const values = Object.values(Channels);
            const unique = new Set(values);
            expect(unique.size).toBe(values.length);
        });

        it('should all start with embedBrowser: prefix', () => {
            for (const ch of Object.values(Channels)) {
                expect(ch).toMatch(/^embedBrowser:/);
            }
        });
    });

    describe('Type shapes (compile-time checks)', () => {
        it('BrowserState should have required fields', () => {
            const state: BrowserState = {
                currentUrl: 'https://example.com',
                canGoBack: true,
                canGoForward: false,
                isFullscreen: false
            };
            expect(state.currentUrl).toBe('https://example.com');
        });

        it('TabInfo should have required fields', () => {
            const tab: TabInfo = {
                id: 1,
                title: 'Test',
                url: 'https://example.com',
                active: true
            };
            expect(tab.id).toBe(1);
        });

        it('PageSnapshot should have required fields', () => {
            const snapshot: PageSnapshot = {
                url: 'https://example.com',
                title: 'Test',
                viewport: { width: 1280, height: 800 },
                scroll: { x: 0, y: 100 },
                ariaSnapshot: '- heading "Test"'
            };
            expect(snapshot.viewport.width).toBe(1280);
        });

        it('IPCResponse should support ok and error', () => {
            const okResp: IPCResponse<string> = { status: 'ok', data: 'hello' };
            const errResp: IPCResponse = { status: 'error', message: 'fail' };
            expect(okResp.status).toBe('ok');
            expect(errResp.status).toBe('error');
        });
    });
});
