/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { BrowserInstance } from '../renderer';
import type { BrowserState, TabInfo } from '../protocol';

/**
 * Concrete test implementation of BrowserInstance.
 */
class TestBrowser extends BrowserInstance {
    public calls: { method: string; args: any[] }[] = [];

    navigateTo(url: string): void {
        this.calls.push({ method: 'navigateTo', args: [url] });
    }
    goBack(): void {
        this.calls.push({ method: 'goBack', args: [] });
    }
    goForward(): void {
        this.calls.push({ method: 'goForward', args: [] });
    }
    refresh(): void {
        this.calls.push({ method: 'refresh', args: [] });
    }
    goHome(): void {
        this.calls.push({ method: 'goHome', args: [] });
    }
    getState(): BrowserState {
        return { currentUrl: 'https://test.com', canGoBack: true, canGoForward: false, isFullscreen: false };
    }
    getCurrentUrl(): string {
        return 'https://test.com';
    }
    executeJavaScript(script: string): Promise<unknown> {
        this.calls.push({ method: 'executeJavaScript', args: [script] });
        return Promise.resolve('result');
    }
    getWebContentsId(): number | null {
        return 42;
    }
    focusActiveWebview(): boolean {
        this.calls.push({ method: 'focusActiveWebview', args: [] });
        return true;
    }
    capturePage(): Promise<string | null> {
        return Promise.resolve('data:image/png;base64,...');
    }
    listTabs(): TabInfo[] {
        return [{ id: 1, title: 'Tab 1', url: 'https://test.com', active: true }];
    }
    addTab(url?: string): number {
        this.calls.push({ method: 'addTab', args: [url] });
        return 2;
    }
    closeTab(tabId: number): void {
        this.calls.push({ method: 'closeTab', args: [tabId] });
    }
    switchToTab(tabId: number): void {
        this.calls.push({ method: 'switchToTab', args: [tabId] });
    }
    destroy(): void {
        this.calls.push({ method: 'destroy', args: [] });
    }
}

describe('embedBrowserUse/renderer', () => {
    describe('BrowserInstance', () => {
        it('should store the instance id', () => {
            const browser = new TestBrowser('task-123');
            expect(browser.id).toBe('task-123');
        });

        it('should expose abstract methods', () => {
            const browser = new TestBrowser('task-1');
            browser.navigateTo('https://example.com');
            expect(browser.calls).toContainEqual({ method: 'navigateTo', args: ['https://example.com'] });
        });

        it('should return state', () => {
            const browser = new TestBrowser('task-1');
            const state = browser.getState();
            expect(state.currentUrl).toBe('https://test.com');
            expect(state.canGoBack).toBe(true);
        });

        it('should list tabs', () => {
            const browser = new TestBrowser('task-1');
            const tabs = browser.listTabs();
            expect(tabs).toHaveLength(1);
            expect(tabs[0].title).toBe('Tab 1');
        });

        it('should register with bridge API', () => {
            const browser = new TestBrowser('task-123');
            const registered = new Map<string, BrowserInstance>();
            const bridge = {
                _registerInstance: (id: string, inst: BrowserInstance) => {
                    registered.set(id, inst);
                }
            };
            browser.register(bridge as any);
            expect(registered.get('task-123')).toBe(browser);
        });

        it('should unregister from bridge API', () => {
            const browser = new TestBrowser('task-123');
            const registered = new Map<string, BrowserInstance>();
            registered.set('task-123', browser);
            const bridge = {
                _unregisterInstance: (id: string) => {
                    registered.delete(id);
                }
            };
            browser.unregister(bridge as any);
            expect(registered.has('task-123')).toBe(false);
        });

        it('should not throw if bridge has no registration methods', () => {
            const browser = new TestBrowser('task-1');
            expect(() => browser.register({} as any)).not.toThrow();
            expect(() => browser.unregister({} as any)).not.toThrow();
        });
    });
});
