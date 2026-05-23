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

/**
 * embedBrowserUse — Main process browser controller and manager.
 *
 * BrowserController: per-instance controller with CDP automation logic.
 * BrowserManager: singleton that manages controllers and IPC bindings.
 */

import { Channels } from './protocol';
import type { BrowserState, TabInfo, PageSnapshot, IPCResponse } from './protocol';
import { CDPSession, CDPSessionManager, setCDPLogger } from './cdp/session';
import { captureSnapshot, resolveTargetCoords } from './cdp/snapshot';
import { resolveKey, modifiersBitmask, sleep, withRetry } from './cdp/utils';
import type { CDPLogger } from './cdp/session';

export type { CDPSession } from './cdp/session';
export { CDPSessionManager } from './cdp/session';
export { captureSnapshot, resolveTargetCoords } from './cdp/snapshot';
export { resolveKey, modifiersBitmask, sleep, withRetry } from './cdp/utils';

// Re-export setCDPLogger so consumers can wire in their project logger
export { setCDPLogger };
export type { CDPLogger };

// ---------------------------------------------------------------------------
// Script generators for renderer bridge
// ---------------------------------------------------------------------------

/**
 * 生成用于在 renderer 中确保 task-view / 侧边栏已准备好的 JS 代码片段。
 */
export function makeEnsureSidebarScript(taskId: string): string {
    const safeId = taskId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `
        if (window.globalControlAPI && typeof window.globalControlAPI.ensureTaskViewExists === 'function') {
            window.globalControlAPI.ensureTaskViewExists('${safeId}');
        }
        var el = document.getElementById('task-${safeId}-artifacts');
        if (el) {
            var tv = el.closest('task-view');
            if (tv && tv.hasAttribute('data-background')) {
                el.style.display = '';
                el.style.width = '1280px';
                if (typeof el.ensureBrowserReady === 'function') el.ensureBrowserReady();
            } else {
                var wasExpanded = tv && tv.constructor && tv.constructor.rightSidebarExpanded;
                if (tv && typeof tv._ensureRightSidebarOpen === 'function') tv._ensureRightSidebarOpen();
                if (wasExpanded) el._suppressBrowserAutoSwitch = true;
                if (typeof el.ensureBrowserReady === 'function') el.ensureBrowserReady(!wasExpanded);
            }
        }
    `;
}

/**
 * 生成在 renderer 中调用 task-artifacts 元素上同步方法的完整 IIFE 脚本。
 */
export function makeCallBrowserScript(taskId: string, method: string, args: unknown[]): string {
    const safeId = taskId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const safeMethod = method.replace(/[^a-zA-Z0-9_]/g, '');
    const argsStr = args.map((a) => JSON.stringify(a)).join(',');
    return `(() => {
        ${makeEnsureSidebarScript(taskId)}
        var el = document.getElementById('task-${safeId}-artifacts');
        if (!el) return { error: 'Browser not available for task ${safeId}' };
        if (typeof el.${safeMethod} !== 'function') return { error: 'Method ${safeMethod} not available' };
        var r = el.${safeMethod}(${argsStr});
        el._suppressBrowserAutoSwitch = false;
        return r instanceof Promise ? null : { result: r };
    })()`;
}

/**
 * 生成在 renderer 中对 task-artifacts 的 webview 执行异步脚本的完整 IIFE。
 */
export function makeExecuteScriptOnBrowser(taskId: string, script: string): string {
    const safeId = taskId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `(() => {
        ${makeEnsureSidebarScript(taskId)}
        var el = document.getElementById('task-${safeId}-artifacts');
        if (!el) return { error: 'Browser not available' };
        if (typeof el.browserExecuteScript !== 'function') return { error: 'Browser not initialized' };
        var p = el.browserExecuteScript(${JSON.stringify(script)});
        el._suppressBrowserAutoSwitch = false;
        return p
            .then(r => ({ result: r }))
            .catch(e => ({ error: e.message || String(e) }));
    })()`;
}

// ---------------------------------------------------------------------------
// BrowserController — per-instance controller
// ---------------------------------------------------------------------------

/**
 * Per-instance browser controller that encapsulates all CDP-based automation
 * operations. Each controller is associated with a unique instance ID
 * (typically a taskId) and a main BrowserWindow for renderer communication.
 */
export class BrowserController {
    public readonly id: string;
    private _mainWindow: Electron.BrowserWindow | null;
    private _cdpManager: CDPSessionManager;

    // Serialize all browser actions to prevent concurrent CDP conflicts
    // (e.g. two type() calls interleaving keystrokes into wrong elements)
    private _actionQueue: Promise<any> = Promise.resolve();

    constructor(id: string, mainWindow: Electron.BrowserWindow | null) {
        this.id = id;
        this._mainWindow = mainWindow;
        this._cdpManager = new CDPSessionManager();
    }

    /**
     * Acquire an exclusive lock before executing `fn`.  All public action
     * methods are wrapped with this so that at most one CDP interaction
     * runs at a time per controller instance.
     */
    private _withExclusiveLock<T>(fn: () => Promise<T>): Promise<T> {
        let releaseLock!: () => void;
        const nextSlot = new Promise<void>((resolve) => {
            releaseLock = resolve;
        });
        const waiting = this._actionQueue;
        this._actionQueue = nextSlot;
        return waiting.then(async () => {
            try {
                return await fn();
            } finally {
                releaseLock();
            }
        });
    }

    setMainWindow(win: Electron.BrowserWindow | null): void {
        this._mainWindow = win;
    }

    // ---- CDP Session Access ----

    /**
     * Obtain a CDP session for this instance's active webview.
     * Flow: renderer → webContentsId → main process CDP attach.
     */
    async getCDPSession(): Promise<CDPSession | null> {
        try {
            const wcId = await this.callRendererBrowser('browserGetWebContentsId');
            if (wcId == null) return null;
            return await this._cdpManager.getSession(wcId);
        } catch {
            return null;
        }
    }

    /**
     * Get a healthy CDP session with retry + health check.
     */
    async requireCDP(): Promise<CDPSession> {
        return withRetry(
            async () => {
                const session = await this.getCDPSession();
                if (!session) throw new Error('CDP session not available — browser may not be ready');
                const healthy = await session.isHealthy();
                if (!healthy) throw new Error('CDP session unhealthy — will retry');
                return session;
            },
            { delays: [300, 600, 1200, 2000], shouldRetry: () => true }
        );
    }

    // ---- Renderer Bridge Methods ----

    /**
     * Call a synchronous method on the task's <task-artifacts> element.
     */
    async callRendererBrowser(method: string, ...args: any[]): Promise<any> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) {
            throw new Error('No main window available');
        }

        const result = await this._mainWindow.webContents.executeJavaScript(
            makeCallBrowserScript(this.id, method, args)
        );

        if (result?.__e) throw new Error(result.__e);
        if (result?.error) throw new Error(result.error);
        return result?.__d ?? result?.result ?? result;
    }

    /**
     * Execute a script in the active webview and return the result.
     */
    async runOnActiveWebview(script: string, timeoutMs: number = 12000): Promise<any> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) {
            throw new Error('No main window available');
        }

        const safeId = this.id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const escapedScript = JSON.stringify(script);

        const jsPromise = this._mainWindow.webContents.executeJavaScript(`
            (async () => {
                try {
                    ${makeEnsureSidebarScript(this.id)}
                    var el = document.getElementById('task-${safeId}-artifacts');
                    if (!el) return { __e: 'Task artifacts element not found' };
                    if (typeof el.browserExecuteScript !== 'function') return { __e: 'Browser not initialized' };
                    var r = await el.browserExecuteScript(${escapedScript});
                    el._suppressBrowserAutoSwitch = false;
                    return { __d: r };
                } catch (e) {
                    return { __e: (e && e.message) || String(e) };
                }
            })()
        `);

        const result = await Promise.race([
            jsPromise,
            new Promise<{ __e: string }>((_, reject) =>
                setTimeout(() => reject(new Error(`webview script timed out after ${timeoutMs}ms`)), timeoutMs)
            )
        ]);

        if (result?.__e) throw new Error(result.__e);
        return result?.__d;
    }

    /**
     * Ensure sidebar is expanded and browser tab is active.
     */
    async ensureSidebar(): Promise<void> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) return;
        await this._mainWindow.webContents.executeJavaScript(`(() => { ${makeEnsureSidebarScript(this.id)} })()`);
    }

    // ---- Page Info Helpers ----

    /**
     * Read current page URL + title from a CDP session.
     */
    async readPageInfo(session: CDPSession): Promise<{ url: string; title: string; error?: string }> {
        const result = await session.send('Runtime.evaluate', {
            expression: `JSON.stringify({ url: location.href, title: document.title })`,
            returnByValue: true
        });
        const info = JSON.parse(result.result.value);

        // Detect Chromium error pages (chrome-error://chromewebdata/)
        if (typeof info.url === 'string' && info.url.startsWith('chrome-error://')) {
            try {
                const errResult = await session.send('Runtime.evaluate', {
                    expression: `(() => {
                        var diag = document.getElementById('sub-frame-error-details') || document.getElementById('main-message');
                        var details = diag ? diag.innerText.trim() : '';
                        var heading = document.querySelector('.error-code') || document.querySelector('h1');
                        var code = heading ? heading.innerText.trim() : '';
                        return JSON.stringify({ code: code, details: details });
                    })()`,
                    returnByValue: true
                });
                const errInfo = JSON.parse(errResult.result.value);
                const errorMsg = [errInfo.code, errInfo.details].filter(Boolean).join(': ') || 'Page failed to load';
                return { url: info.url, title: info.title, error: errorMsg };
            } catch {
                return { url: info.url, title: info.title, error: 'Page failed to load (chrome-error)' };
            }
        }

        return info;
    }

    /**
     * Read compact page state after an action.
     */
    async readPageState(session: CDPSession): Promise<Record<string, any> | null> {
        try {
            const result = await session.send('Runtime.evaluate', {
                expression: `JSON.stringify({
                    url: location.href,
                    title: document.title,
                    scrollY: Math.round(window.scrollY),
                    scrollHeight: document.documentElement.scrollHeight,
                    viewportHeight: window.innerHeight,
                })`,
                returnByValue: true
            });
            return JSON.parse(result.result.value);
        } catch {
            return null;
        }
    }

    /**
     * Wait for click side-effects (navigation, etc.) to settle.
     */
    async waitForClickCompletion(session: CDPSession, callback: () => Promise<void>): Promise<void> {
        let urlBefore: string | null = null;
        try {
            const r = await session.send('Runtime.evaluate', {
                expression: 'location.href',
                returnByValue: true
            });
            urlBefore = r.result.value;
        } catch {
            /* page may be in transition */
        }

        await callback();
        await sleep(500);

        try {
            const r = await session.send('Runtime.evaluate', {
                expression: 'location.href',
                returnByValue: true
            });
            const urlAfter = r.result.value;
            if (urlAfter !== urlBefore) {
                await session.waitForPageReady(8000);
            }
        } catch {
            await session.waitForPageReady(8000);
        }
    }

    // ---- High-Level Operations (used by agent tools) ----

    async navigate(url: string, newTab: boolean = false): Promise<{ url: string; title: string; error?: string }> {
        return this._withExclusiveLock(async () => {
            // Normalize URL
            try {
                new URL(url);
            } catch {
                if (url.startsWith('localhost') || /^\d+\.\d+\.\d+\.\d+/.test(url)) url = 'http://' + url;
                else if (!url.includes('://')) url = 'https://' + url;
            }

            const NAVIGATE_TIMEOUT = 20000;

            const navigateAndWait = async (): Promise<{ url: string; title: string; error?: string }> => {
                if (newTab) {
                    await this.callRendererBrowser('browserAddTab', url);
                } else {
                    await this.callRendererBrowser('browserNavigate', url);
                }

                await sleep(400);

                const session = await this.getCDPSession();
                if (session) {
                    await session.waitForPageReady(NAVIGATE_TIMEOUT - 2000);
                    await sleep(200);
                    const info = await this.readPageInfo(session);
                    if (info.error) {
                        return { url, title: '', error: `页面加载失败: ${info.error} (请求地址: ${url})` };
                    }
                    if (info.url && info.url !== 'about:blank') {
                        return { url: info.url, title: info.title };
                    }
                }

                return { url, title: '(页面加载中)' };
            };

            return Promise.race([
                navigateAndWait(),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `导航超时（${NAVIGATE_TIMEOUT / 1000}秒）：无法加载 ${url}，网址可能不可用或网络连接异常`
                                )
                            ),
                        NAVIGATE_TIMEOUT
                    )
                )
            ]);
        });
    }

    async snapshot(): Promise<PageSnapshot> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            return captureSnapshot(session);
        });
    }

    async click(
        target: string,
        options: { button?: 'left' | 'right' | 'middle'; doubleClick?: boolean; modifiers?: string[] } = {}
    ): Promise<{ target: string; tag: string; text: string; page?: Record<string, any> | null }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const coords = await resolveTargetCoords(session, target);
            const modMask = modifiersBitmask(options.modifiers);
            const clickCount = options.doubleClick ? 2 : 1;
            const button = options.button || 'left';

            const performClick = async () => {
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: coords.x,
                    y: coords.y,
                    modifiers: modMask
                });
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: coords.x,
                    y: coords.y,
                    button,
                    clickCount,
                    modifiers: modMask
                });
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: coords.x,
                    y: coords.y,
                    button,
                    clickCount,
                    modifiers: modMask
                });

                if (button === 'right') {
                    await session
                        .send('Runtime.evaluate', {
                            expression: `(() => {
                        var el = document.elementFromPoint(${coords.x}, ${coords.y});
                        if (el) el.dispatchEvent(new MouseEvent('contextmenu', {
                            bubbles: true, cancelable: true, view: window,
                            clientX: ${coords.x}, clientY: ${coords.y}, button: 2
                        }));
                    })()`,
                            returnByValue: true
                        })
                        .catch(() => {});
                }

                if ((coords as any).obscured && button === 'left') {
                    const targetExpr = /^e\d+$/.test(target)
                        ? `document.querySelector('[data-od-ref="${target}"]')`
                        : `document.querySelector(${JSON.stringify(target)})`;
                    await session
                        .send('Runtime.evaluate', {
                            expression: `(() => { var el = ${targetExpr}; if (el) el.click(); })()`,
                            returnByValue: true
                        })
                        .catch(() => {});
                }
            };

            await this.waitForClickCompletion(session, performClick);
            const pageState = await this.readPageState(session);
            return { target, tag: coords.tag, text: coords.text, ...(pageState && { page: pageState }) };
        });
    }

    async type(
        target: string,
        text: string,
        options: { clearFirst?: boolean; submit?: boolean; slowly?: boolean } = {}
    ): Promise<{ target: string; typed: number }> {
        return this._withExclusiveLock(async () => {
            const { clearFirst = true, submit = false, slowly = false } = options;
            const session = await this.requireCDP();

            // Click to focus
            const coords = await resolveTargetCoords(session, target);
            await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y });
            await session.send('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: coords.x,
                y: coords.y,
                button: 'left',
                clickCount: 1
            });
            await session.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: coords.x,
                y: coords.y,
                button: 'left',
                clickCount: 1
            });
            await sleep(50);

            // Prepare text to input
            let textToInsert = text;

            // In append mode, get current value and concatenate
            if (!clearFirst && text) {
                // Wait a bit more for focus to settle before reading value
                await sleep(50);
                const result = (await session.send('Runtime.evaluate', {
                    expression: `
                    (() => {
                        const el = document.activeElement;
                        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                            return el.value || '';
                        } else if (el && el.isContentEditable) {
                            return el.innerText || el.textContent || '';
                        }
                        return '';
                    })()
                `,
                    returnByValue: true
                })) as { result?: { value?: string } };
                const currentValue = result.result?.value || '';
                textToInsert = currentValue + text;
            }

            // Clear existing text using JavaScript
            await session.send('Runtime.evaluate', {
                expression: `
                (() => {
                    const el = document.activeElement;
                    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                        el.value = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (el && el.isContentEditable) {
                        el.textContent = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                })()
            `
            });
            await sleep(30);

            if (textToInsert) {
                if (slowly) {
                    for (const ch of textToInsert) {
                        const desc = resolveKey(ch);
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyDown',
                            key: desc.key,
                            code: desc.code,
                            windowsVirtualKeyCode: desc.keyCode,
                            text: desc.text || ''
                        });
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyUp',
                            key: desc.key,
                            code: desc.code,
                            windowsVirtualKeyCode: desc.keyCode
                        });
                        await sleep(30);
                    }
                } else {
                    await session.send('Input.insertText', { text: textToInsert });
                }
            }

            if (submit) {
                await sleep(50);
                await this.waitForClickCompletion(session, async () => {
                    await session.send('Input.dispatchKeyEvent', {
                        type: 'keyDown',
                        key: 'Enter',
                        code: 'Enter',
                        windowsVirtualKeyCode: 13
                    });
                    await session.send('Input.dispatchKeyEvent', {
                        type: 'keyUp',
                        key: 'Enter',
                        code: 'Enter',
                        windowsVirtualKeyCode: 13
                    });
                });
            }

            return { target, typed: text.length };
        });
    }

    async hover(target: string): Promise<{ target: string; tag: string; text: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const coords = await resolveTargetCoords(session, target);
            await session.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: coords.x,
                y: coords.y
            });
            return { target, tag: coords.tag, text: coords.text };
        });
    }

    async pressKey(key: string, modifiers?: string[]): Promise<{ key: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const keyDesc = resolveKey(key);
            const modMask = modifiersBitmask(modifiers);

            await session.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: keyDesc.key,
                code: keyDesc.code,
                windowsVirtualKeyCode: keyDesc.keyCode,
                text: keyDesc.text || '',
                modifiers: modMask
            });
            await session.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: keyDesc.key,
                code: keyDesc.code,
                windowsVirtualKeyCode: keyDesc.keyCode,
                modifiers: modMask
            });

            return { key };
        });
    }

    async selectOption(target: string, values: string[]): Promise<{ selected: string[] }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const valuesJSON = JSON.stringify(values);

            const isRef = /^e\d+$/.test(target);
            const selectorExpr = isRef
                ? `document.querySelector('[data-od-ref="${target}"]')`
                : `document.querySelector(${JSON.stringify(target)})`;

            const result = await session.send('Runtime.evaluate', {
                expression: `(() => {
                var el = ${selectorExpr};
                if (!el) return JSON.stringify({ error: 'Element not found' });
                if (el.tagName.toLowerCase() !== 'select') return JSON.stringify({ error: 'Element is not a <select>' });
                var values = ${valuesJSON};
                for (var i = 0; i < el.options.length; i++) {
                    el.options[i].selected = values.indexOf(el.options[i].value) !== -1;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return JSON.stringify({ selected: values });
            })()`,
                returnByValue: true
            });

            const info = JSON.parse(result.result.value);
            if (info.error) throw new Error(info.error);
            return info;
        });
    }

    async scroll(direction: 'up' | 'down', amount: number = 500): Promise<Record<string, any>> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const deltaY = direction === 'up' ? -amount : amount;

            const scrollResult = await session.send('Runtime.evaluate', {
                expression: `(() => {
                var before = window.scrollY;
                window.scrollBy({ top: ${deltaY}, behavior: 'instant' });
                return JSON.stringify({ before: before, after: window.scrollY });
            })()`,
                returnByValue: true
            });
            const scrollDelta = JSON.parse(scrollResult.result.value);
            const jsScrollWorked = scrollDelta.before !== scrollDelta.after;

            if (!jsScrollWorked) {
                const vpResult = await session.send('Runtime.evaluate', {
                    expression: `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`,
                    returnByValue: true
                });
                const vp = JSON.parse(vpResult.result.value);
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: Math.round(vp.w / 2),
                    y: Math.round(vp.h / 2),
                    deltaX: 0,
                    deltaY
                });
            }

            await sleep(200);

            const result = await session.send('Runtime.evaluate', {
                expression: `JSON.stringify({
                scrollY: Math.round(window.scrollY),
                scrollHeight: document.documentElement.scrollHeight,
                viewportHeight: window.innerHeight,
                atTop: window.scrollY <= 0,
                atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1,
                percentScrolled: Math.round(window.scrollY / Math.max(document.documentElement.scrollHeight - window.innerHeight, 1) * 100)
            })`,
                returnByValue: true
            });
            return JSON.parse(result.result.value);
        });
    }

    async goBack(): Promise<{ url: string; title: string; error?: string }> {
        return this._withExclusiveLock(async () => {
            await this.callRendererBrowser('browserGoBack');
            const session = await this.getCDPSession();
            if (session) {
                await session.waitForPageReady(8000);
                try {
                    return await this.readPageInfo(session);
                } catch {
                    /* fall through */
                }
            }
            await sleep(500);
            const raw = await this.runOnActiveWebview(
                `JSON.stringify({ url: location.href, title: document.title })`,
                5000
            );
            const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return { url: info.url, title: info.title };
        });
    }

    async goForward(): Promise<{ url: string; title: string; error?: string }> {
        return this._withExclusiveLock(async () => {
            await this.callRendererBrowser('browserGoForward');
            const session = await this.getCDPSession();
            if (session) {
                await session.waitForPageReady(8000);
                try {
                    return await this.readPageInfo(session);
                } catch {
                    /* fall through */
                }
            }
            await sleep(500);
            const raw = await this.runOnActiveWebview(
                `JSON.stringify({ url: location.href, title: document.title })`,
                5000
            );
            const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return { url: info.url, title: info.title };
        });
    }

    async reload(): Promise<{ url: string; title: string; error?: string }> {
        return this._withExclusiveLock(async () => {
            // Use the renderer bridge (webview.reload) instead of CDP Page.reload.
            // CDP Page.reload on a <webview>'s guest webContents can cause the
            // Electron host frame to reload or navigate to about:blank.
            await this.callRendererBrowser('browserRefresh');
            const session = await this.getCDPSession();
            if (session) {
                await session.waitForPageReady(12000);
                try {
                    return await this.readPageInfo(session);
                } catch {
                    /* fall through */
                }
            }
            await sleep(1000);
            try {
                const raw = await this.runOnActiveWebview(
                    `JSON.stringify({ url: location.href, title: document.title })`,
                    5000
                );
                const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return { url: info.url, title: info.title };
            } catch {
                /* best effort */
            }
            return { url: '(reloaded)', title: '' };
        });
    }

    async evaluate(expression: string): Promise<any> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const result = await session.send('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true
            });

            if (result.exceptionDetails) {
                const msg =
                    result.exceptionDetails.text ||
                    result.exceptionDetails.exception?.description ||
                    'Evaluation error';
                throw new Error(msg);
            }

            return result.result.value;
        });
    }

    async tabs(
        action: 'list' | 'new' | 'close' | 'switch',
        tabId?: number,
        url?: string
    ): Promise<{ tabs?: TabInfo[]; tabId?: number; url?: string; closed?: number; switched?: number }> {
        return this._withExclusiveLock(async () => {
            switch (action) {
                case 'list': {
                    const tabList = await this.callRendererBrowser('browserListTabs');
                    return { tabs: tabList };
                }
                case 'new': {
                    const newUrl = url || 'about:blank';
                    const newTabId = await this.callRendererBrowser('browserAddTab', newUrl);
                    return { tabId: newTabId, url: newUrl };
                }
                case 'close': {
                    if (tabId === undefined) throw new Error('close 操作需要提供 tabId');
                    await this.callRendererBrowser('browserCloseTab', tabId);
                    return { closed: tabId };
                }
                case 'switch': {
                    if (tabId === undefined) throw new Error('switch 操作需要提供 tabId');
                    await this.callRendererBrowser('browserSwitchTab', tabId);
                    return { switched: tabId };
                }
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
        });
    }

    async waitFor(options: { text?: string; textGone?: string; timeout?: number }): Promise<{ condition: string }> {
        return this._withExclusiveLock(async () => {
            if (!options.text && !options.textGone) {
                throw new Error('必须提供 text 或 textGone 之一');
            }

            const session = await this.requireCDP();
            const timeoutMs = (options.timeout ?? 10) * 1000;
            const pollInterval = 400;
            const deadline = Date.now() + timeoutMs;

            const needle = options.text || options.textGone!;
            const wantPresent = !!options.text;

            const needleEscaped = JSON.stringify(needle);
            const checkExpr = `(() => {
            var needle = ${needleEscaped};
            var normalize = function(s) { return s.replace(/[\\s\\u00A0\\u3000]+/g, ' ').trim(); };
            var haystack = normalize(document.body.innerText || '');
            if (haystack.indexOf(needle) !== -1) return true;
            haystack = normalize(document.body.textContent || '');
            if (haystack.indexOf(needle) !== -1) return true;
            var nNeedle = normalize(needle);
            if (nNeedle !== needle) {
                haystack = normalize(document.body.innerText || '');
                if (haystack.indexOf(nNeedle) !== -1) return true;
            }
            return false;
        })()`;

            while (Date.now() < deadline) {
                try {
                    const result = await session.send('Runtime.evaluate', {
                        expression: checkExpr,
                        returnByValue: true
                    });
                    const found = result.result.value === true;
                    if (wantPresent ? found : !found) {
                        return { condition: wantPresent ? 'text found' : 'text gone' };
                    }
                } catch {
                    // Page may be reloading — retry
                }
                await sleep(pollInterval);
            }

            throw new Error(
                `等待超时（${options.timeout}秒）：${wantPresent ? `文本 "${needle}" 未出现` : `文本 "${needle}" 未消失`}`
            );
        });
    }

    dispose(): void {
        this._cdpManager.disposeAll();
        this._mainWindow = null;
    }
}

// ---------------------------------------------------------------------------
// BrowserManager — singleton controller registry + IPC binding
// ---------------------------------------------------------------------------

export class BrowserManager {
    private static _controllers = new Map<string, BrowserController>();
    private static _mainWindow: Electron.BrowserWindow | null = null;
    private static _browserSession: Electron.Session | null = null;
    private static _bound = false;

    /** Get the main window reference (for direct renderer script execution). */
    static get mainWindow(): Electron.BrowserWindow | null {
        return BrowserManager._mainWindow;
    }

    /** Set the main window reference used when creating new controllers. */
    static setMainWindow(win: Electron.BrowserWindow | null): void {
        BrowserManager._mainWindow = win;
        // Update all existing controllers
        for (const ctrl of BrowserManager._controllers.values()) {
            ctrl.setMainWindow(win);
        }
    }

    /** Get or create a BrowserController for the given instance ID. */
    static getOrCreateController(id: string, mainWindow?: Electron.BrowserWindow | null): BrowserController {
        let ctrl = BrowserManager._controllers.get(id);
        if (!ctrl) {
            ctrl = new BrowserController(id, mainWindow ?? BrowserManager._mainWindow);
            BrowserManager._controllers.set(id, ctrl);
        }
        return ctrl;
    }

    /** Get an existing controller (returns undefined if not found). */
    static getController(id: string): BrowserController | undefined {
        return BrowserManager._controllers.get(id);
    }

    /** Remove and dispose a controller. */
    static removeController(id: string): void {
        const ctrl = BrowserManager._controllers.get(id);
        if (ctrl) {
            ctrl.dispose();
            BrowserManager._controllers.delete(id);
        }
    }

    /** Get the shared browser session. */
    static get browserSession(): Electron.Session | null {
        return BrowserManager._browserSession;
    }

    /**
     * Initialize the shared persistent browser session.
     */
    static initSession(partition: string = 'persist:opendesk-browser'): Electron.Session | null {
        try {
            // Dynamic import to avoid requiring electron at module load time
            const { session } = require('electron');
            BrowserManager._browserSession = session.fromPartition(partition);
            BrowserManager._browserSession!.setPermissionRequestHandler(
                (_webContents: any, permission: string, callback: (allowed: boolean) => void) => {
                    const allowed = [
                        'clipboard-read',
                        'clipboard-sanitized-write',
                        'media',
                        'geolocation',
                        'notifications'
                    ];
                    callback(allowed.includes(permission));
                }
            );
            return BrowserManager._browserSession;
        } catch (err) {
            console.error(`Failed to initialize browser session: ${err}`);
            return null;
        }
    }

    /**
     * 将所有 session cookies 转为持久 cookies（30 天过期），确保登录态跨重启保留。
     */
    static async persistSessionCookies(): Promise<void> {
        const ses = BrowserManager._browserSession;
        if (!ses) return;
        const allCookies = await ses.cookies.get({ session: true });
        if (allCookies.length === 0) return;

        const persistentExpiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
        const promises: Promise<void>[] = [];

        for (const cookie of allCookies) {
            const url = `http${cookie.secure ? 's' : ''}://${cookie.domain?.replace(/^\./, '') || 'localhost'}${cookie.path || '/'}`;
            promises.push(
                ses.cookies
                    .set({
                        url,
                        name: cookie.name,
                        value: cookie.value,
                        domain: cookie.domain,
                        path: cookie.path,
                        secure: cookie.secure,
                        httpOnly: cookie.httpOnly,
                        sameSite: cookie.sameSite as any,
                        expirationDate: persistentExpiry
                    })
                    .catch(() => {})
            );
        }

        await Promise.all(promises);
    }

    /**
     * Bind IPC handlers for all browser channels.
     * This replaces the old registerBrowserAPIHandlers() in main.ts.
     */
    static bind(ipcMain: { handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void }): void {
        if (BrowserManager._bound) return;
        BrowserManager._bound = true;

        const callBrowserOnTask = async (taskId: string, method: string, ...args: unknown[]): Promise<IPCResponse> => {
            if (!BrowserManager._mainWindow) {
                return { status: 'error', message: 'No main window' };
            }
            try {
                const result = await BrowserManager._mainWindow.webContents.executeJavaScript(
                    makeCallBrowserScript(taskId, method, args)
                );
                if (result && result.error) {
                    return { status: 'error', message: result.error };
                }
                return { status: 'ok', data: result?.result ?? result };
            } catch (err) {
                return { status: 'error', message: String(err) };
            }
        };

        ipcMain.handle(Channels.navigate, async (_event: any, taskId: string, url: string) => {
            return callBrowserOnTask(taskId, 'browserNavigate', url);
        });

        ipcMain.handle(Channels.getState, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserGetState');
        });

        ipcMain.handle(Channels.executeScript, async (_event: any, taskId: string, script: string) => {
            if (!BrowserManager._mainWindow) {
                return { status: 'error', message: 'No main window' };
            }
            try {
                const result = await BrowserManager._mainWindow.webContents.executeJavaScript(
                    makeExecuteScriptOnBrowser(taskId, script)
                );
                if (result && result.error) {
                    return { status: 'error', message: result.error };
                }
                return { status: 'ok', data: result?.result ?? result };
            } catch (err) {
                return { status: 'error', message: String(err) };
            }
        });

        ipcMain.handle(Channels.goBack, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserGoBack');
        });

        ipcMain.handle(Channels.goForward, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserGoForward');
        });

        ipcMain.handle(Channels.refresh, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserRefresh');
        });

        ipcMain.handle(Channels.listTabs, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserListTabs');
        });

        ipcMain.handle(Channels.addTab, async (_event: any, taskId: string, url: string) => {
            return callBrowserOnTask(taskId, 'browserAddTab', url);
        });

        ipcMain.handle(Channels.closeTab, async (_event: any, taskId: string, tabId: number) => {
            return callBrowserOnTask(taskId, 'browserCloseTab', tabId);
        });

        ipcMain.handle(Channels.switchTab, async (_event: any, taskId: string, tabId: number) => {
            return callBrowserOnTask(taskId, 'browserSwitchTab', tabId);
        });

        ipcMain.handle(Channels.getWebContentsId, async (_event: any, taskId: string) => {
            return callBrowserOnTask(taskId, 'browserGetWebContentsId');
        });

        ipcMain.handle(Channels.captureScreenshot, async (_event: any, webContentsId: number) => {
            try {
                const { webContents } = await import('electron');
                const wc = webContents.fromId(webContentsId);
                if (!wc || wc.isDestroyed()) {
                    return { status: 'error', message: 'WebContents not found or destroyed' };
                }
                // 使用 Electron 原生 capturePage 而非 CDP debugger，
                // 避免触发页面的反调试/安全检测机制（如 SSO 登录页）
                const image = await wc.capturePage();
                if (image.isEmpty()) {
                    return { status: 'error', message: 'Empty capture' };
                }
                const jpeg = image.toJPEG(70);
                return { status: 'ok', data: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
            } catch (err) {
                return { status: 'error', message: String(err) };
            }
        });

        ipcMain.handle(Channels.openDevTools, async (_event: any, webContentsId: number) => {
            try {
                const { webContents } = await import('electron');
                const wc = webContents.fromId(webContentsId);
                if (!wc || wc.isDestroyed()) {
                    return { status: 'error', message: 'WebContents not found or destroyed' };
                }
                wc.openDevTools();
                return { status: 'ok' };
            } catch (err) {
                return { status: 'error', message: String(err) };
            }
        });

        ipcMain.handle(Channels.exportSnapshot, async (_event: any, webContentsId: number) => {
            try {
                const { webContents, BrowserWindow, dialog } = await import('electron');
                const wc = webContents.fromId(webContentsId);
                if (!wc || wc.isDestroyed()) {
                    return { status: 'error', message: 'WebContents not found or destroyed' };
                }
                const sessionMgr = new CDPSessionManager();
                const session = await sessionMgr.getSession(webContentsId);
                const snapshot: PageSnapshot = await captureSnapshot(session);

                const lines: string[] = [];
                lines.push(`- Page URL: ${snapshot.url}`);
                if (snapshot.title) lines.push(`- Page Title: ${snapshot.title}`);
                lines.push(`- Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`);
                if (snapshot.scroll.x || snapshot.scroll.y)
                    lines.push(`- Scroll: ${snapshot.scroll.x},${snapshot.scroll.y}`);
                lines.push('');
                lines.push('[Accessibility Snapshot]');
                lines.push(snapshot.ariaSnapshot);
                const content = lines.join('\n');

                const win =
                    BrowserWindow.getFocusedWindow() ??
                    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
                    null;
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const dialogOptions = {
                    title: '保存 Snapshot',
                    defaultPath: `snapshot-${timestamp}.txt`,
                    filters: [
                        { name: 'Text Files', extensions: ['txt'] },
                        { name: 'All Files', extensions: ['*'] }
                    ]
                };
                const saveResult = win
                    ? await dialog.showSaveDialog(win, dialogOptions)
                    : await dialog.showSaveDialog(dialogOptions);

                if (saveResult.canceled || !saveResult.filePath) {
                    return { status: 'ok', data: { canceled: true, filePath: null } };
                }

                const fs = await import('node:fs/promises');
                await fs.writeFile(saveResult.filePath, content, 'utf8');
                return { status: 'ok', data: { canceled: false, filePath: saveResult.filePath } };
            } catch (err) {
                return { status: 'error', message: String(err) };
            }
        });
    }
}
