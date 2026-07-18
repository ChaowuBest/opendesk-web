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
import { isNestedRef, parseRef, resolveNestedRefCoords, navigateToFrame, navigateIntoFrame } from './cdp/aria';
import { resolveKey, modifiersBitmask, sleep, withRetry } from './cdp/utils';
import type { CDPLogger } from './cdp/session';
import fs from 'node:fs/promises';
import path from 'node:path';

export type { CDPSession } from './cdp/session';
export { CDPSessionManager } from './cdp/session';
export { captureSnapshot, resolveTargetCoords } from './cdp/snapshot';
export {
    isNestedRef,
    parseRef,
    resolveNestedRefCoords,
    navigateToFrame,
    navigateIntoFrame,
    renderAriaTreeToYaml,
    mergeFrameTrees
} from './cdp/aria';
export type { AriaNode, FrameAriaResult } from './cdp/aria';
export { resolveKey, modifiersBitmask, sleep, withRetry } from './cdp/utils';

// Re-export setCDPLogger so consumers can wire in their project logger
export { setCDPLogger };
export type { CDPLogger };

// ---------------------------------------------------------------------------
// Script generators interface for renderer bridge
// ---------------------------------------------------------------------------

/**
 * 脚本生成器接口。
 *
 * embedBrowserUse 是通用的 CDP 浏览器自动化库。与特定 UI 框架绑定的逻辑
 * 通过此接口注入。`beforeCallRenderer` 列表中的每个 hook 在调用 renderer
 * 桥接之前依次执行（如展开侧边栏、激活浏览器标签等）。
 */
export interface BrowserScriptGenerators {
    /** 调用 renderer 桥接之前执行的脚本生成器列表，按注册顺序执行 */
    beforeCallRenderer: Array<(id: string) => string>;
}

export interface BrowserUploadFileResult {
    target: string;
    tag: string;
    text: string;
    inputRef?: string;
    accept: string;
    multiple: boolean;
    files: Array<{ path: string; name: string; size: number }>;
    page?: Record<string, any> | null;
}

interface ResolvedFileInput {
    tag: string;
    text: string;
    inputRef?: string;
    accept: string;
    multiple: boolean;
    strategy: string;
    error?: string;
}

interface BrowserUploadFilePayload {
    name: string;
    mimeType: string;
    lastModified: number;
    base64: string;
}

const SYNTHETIC_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.xml': 'application/xml',
    '.zip': 'application/zip'
};

// ---------------------------------------------------------------------------
// Generic renderer bridge scripts (no UI framework assumptions)
// ---------------------------------------------------------------------------

/**
 * 生成在 renderer 中调用浏览器元素方法的 IIFE 脚本。
 * 不包含 UI 布局逻辑（如展开侧边栏），由调用方显式处理。
 */
export function makeCallBrowserScript(id: string, method: string, args: unknown[]): string {
    const safeId = id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const safeMethod = method.replace(/[^a-zA-Z0-9_]/g, '');
    const argsStr = args.map((a) => JSON.stringify(a)).join(',');
    return `(() => {
        var el = document.getElementById('task-${safeId}-artifacts');
        if (!el) return { error: 'Browser not available for task ${safeId}' };
        if (typeof el.${safeMethod} !== 'function') return { error: 'Method ${safeMethod} not available' };
        try {
            var r = el.${safeMethod}(${argsStr});
            return Promise.resolve(r)
                .then(function(result) {
                    el._suppressBrowserAutoSwitch = false;
                    return { result: result };
                })
                .catch(function(error) {
                    el._suppressBrowserAutoSwitch = false;
                    return { error: error && error.message ? error.message : String(error) };
                });
        } catch (error) {
            el._suppressBrowserAutoSwitch = false;
            return { error: error && error.message ? error.message : String(error) };
        }
    })()`;
}

/**
 * 生成在 renderer 中对 webview 执行异步脚本的 IIFE。
 * 不包含 UI 布局逻辑，由调用方显式处理。
 */
export function makeExecuteScriptOnBrowser(id: string, script: string): string {
    const safeId = id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `(() => {
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

/**
 * Move focus for plain Tab/Shift+Tab inside a guest browser document. Sending a
 * native Tab through Electron can let focus escape from <webview> back into the
 * embedder UI, so this emulates the browser default focus step in page script
 * after giving page handlers a cancellable keydown event.
 */
export function makePressTabInDocumentScript(reverse: boolean): string {
    return `(() => {
        const reverse = ${reverse ? 'true' : 'false'};

        function makeTabEvent(type) {
            const ev = new KeyboardEvent(type, {
                key: 'Tab',
                code: 'Tab',
                bubbles: true,
                cancelable: true,
                shiftKey: reverse
            });
            try {
                Object.defineProperty(ev, 'keyCode', { get: function() { return 9; } });
                Object.defineProperty(ev, 'which', { get: function() { return 9; } });
            } catch {
                /* ignore */
            }
            return ev;
        }

        function deepestActive(root) {
            let active = root.activeElement || document.activeElement;
            while (active && active.shadowRoot && active.shadowRoot.activeElement) {
                active = active.shadowRoot.activeElement;
            }
            return active || document.body || document.documentElement;
        }

        function isElement(el) {
            return !!el && el.nodeType === Node.ELEMENT_NODE;
        }

        function isVisible(el) {
            if (!isElement(el)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (el.closest('[hidden]')) return false;
            const rects = el.getClientRects();
            return rects.length > 0 || el === document.body || el === document.documentElement;
        }

        function isFocusable(el) {
            if (!isElement(el) || !isVisible(el)) return false;
            const tag = el.tagName.toLowerCase();
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
            if (tag === 'input' && String(el.type || '').toLowerCase() === 'hidden') return false;
            if (el.tabIndex < 0) return false;
            if (el.isContentEditable) return true;
            if (el.hasAttribute('tabindex')) return true;
            if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) return true;
            return ['button', 'input', 'select', 'textarea', 'iframe', 'object', 'embed', 'summary'].includes(tag);
        }

        function collectFocusable(root, out) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let node = walker.nextNode();
            while (node) {
                if (isFocusable(node)) out.push(node);
                if (node.shadowRoot) collectFocusable(node.shadowRoot, out);
                node = walker.nextNode();
            }
        }

        function orderedFocusableElements() {
            const out = [];
            collectFocusable(document.body || document.documentElement, out);
            return out
                .map(function(el, index) {
                    return { el: el, index: index, tabIndex: el.tabIndex || 0 };
                })
                .sort(function(a, b) {
                    const aPositive = a.tabIndex > 0;
                    const bPositive = b.tabIndex > 0;
                    if (aPositive && bPositive && a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex;
                    if (aPositive !== bPositive) return aPositive ? -1 : 1;
                    return a.index - b.index;
                })
                .map(function(item) { return item.el; });
        }

        function describeElement(el) {
            if (!isElement(el)) return {};
            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '')
                .trim()
                .slice(0, 80);
            return { focusedTag: tag, focusedText: text };
        }

        const before = deepestActive(document);
        const eventTarget = before && before.dispatchEvent ? before : document.body || document.documentElement;
        const defaultAllowed = eventTarget.dispatchEvent(makeTabEvent('keydown'));
        let moved = false;

        if (defaultAllowed) {
            const focusables = orderedFocusableElements();
            if (focusables.length > 0) {
                let index = focusables.indexOf(before);
                if (index < 0) {
                    index = focusables.findIndex(function(el) {
                        return before && (el === before || el.contains(before));
                    });
                }
                const nextIndex = reverse
                    ? index <= 0 ? focusables.length - 1 : index - 1
                    : index < 0 || index >= focusables.length - 1 ? 0 : index + 1;
                const next = focusables[nextIndex];
                try {
                    next.focus({ preventScroll: false });
                } catch {
                    next.focus();
                }
                moved = true;
            }
        }

        const after = deepestActive(document);
        const keyupTarget = after && after.dispatchEvent ? after : eventTarget;
        keyupTarget.dispatchEvent(makeTabEvent('keyup'));

        return Object.assign({ handled: true, moved: moved }, describeElement(after));
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
    private _beforeCallRendererHooks: BrowserScriptGenerators | undefined;

    // Serialize all browser actions to prevent concurrent CDP conflicts
    // (e.g. two type() calls interleaving keystrokes into wrong elements)
    private _actionQueue: Promise<any> = Promise.resolve();

    constructor(
        id: string,
        mainWindow: Electron.BrowserWindow | null,
        beforeCallRendererHooks?: BrowserScriptGenerators
    ) {
        this.id = id;
        this._mainWindow = mainWindow;
        this._cdpManager = new CDPSessionManager();
        this._beforeCallRendererHooks = beforeCallRendererHooks;
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

    /**
     * Focus the host window and active guest webContents before keyboard input.
     * CDP can dispatch events without OS-level typing, but Chromium's focus
     * controller still needs the guest page to be the active focused target for
     * keys like Tab that trigger browser-managed default focus navigation.
     */
    private async _focusActiveWebviewForKeyboard(session: CDPSession): Promise<void> {
        try {
            const { BrowserWindow } = await import('electron');
            const guestWebContents = session.webContents as Electron.WebContents & {
                hostWebContents?: Electron.WebContents | null;
            };
            const hostWebContents = guestWebContents.hostWebContents ?? guestWebContents;
            const hostWindow = BrowserWindow.fromWebContents(hostWebContents) ?? this._mainWindow;
            if (hostWindow && !hostWindow.isDestroyed()) {
                hostWindow.focus();
            } else if (this._mainWindow && !this._mainWindow.isDestroyed()) {
                this._mainWindow.focus();
            }
        } catch {
            try {
                this._mainWindow?.focus();
            } catch {
                /* best-effort */
            }
        }

        try {
            await this.callRendererBrowser('browserFocusActiveWebview');
        } catch {
            /* older adapters may not implement this bridge method */
        }

        try {
            session.webContents.focus();
        } catch {
            /* best-effort */
        }

        await sleep(30);
    }

    /**
     * Move focus for plain Tab/Shift+Tab inside the guest document. Sending a
     * native Tab through Electron can let focus escape from <webview> back into
     * the embedder UI, so this path emulates the browser default focus step in
     * page script after giving page handlers a cancellable keydown event.
     */
    private _makePressTabInDocumentScript(reverse: boolean): string {
        return makePressTabInDocumentScript(reverse);
    }

    // ---- Renderer Bridge Methods ----

    /**
     * Call a method on the task's <task-artifacts> element.
     * Both synchronous return values and Promises are supported.
     */
    async callRendererBrowser(method: string, ...args: any[]): Promise<any> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) {
            throw new Error('No main window available');
        }

        // Run registered beforeCallRenderer hooks (e.g. expand sidebar, activate tab)
        await this._beforeCallRenderer();

        const result = await this._mainWindow.webContents.executeJavaScript(
            makeCallBrowserScript(this.id, method, args)
        );

        if (result?.__e) throw new Error(result.__e);
        if (result?.error) throw new Error(result.error);
        return result?.__d ?? result?.result ?? result;
    }

    /**
     * Execute a script in the active webview and return the result.
     * Does NOT run beforeCallRenderer hooks — callers should handle that
     * explicitly if needed (e.g. via callRendererBrowser which does).
     */
    async runOnActiveWebview(script: string, timeoutMs: number = 12000): Promise<any> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) {
            throw new Error('No main window available');
        }

        const jsPromise = this._mainWindow.webContents.executeJavaScript(makeExecuteScriptOnBrowser(this.id, script));

        const result = await Promise.race([
            jsPromise,
            new Promise<{ error: string }>((_, reject) =>
                setTimeout(() => reject(new Error(`webview script timed out after ${timeoutMs}ms`)), timeoutMs)
            )
        ]);

        if (result?.error) throw new Error(result.error);
        return result?.result;
    }

    /**
     * Execute all registered beforeCallRenderer hooks.
     * Each hook generates a JS snippet that is injected into the renderer
     * to prepare the UI (expand sidebar, activate browser tab, etc.).
     */
    private async _beforeCallRenderer(): Promise<void> {
        if (!this._mainWindow || this._mainWindow.isDestroyed()) return;
        if (!this._beforeCallRendererHooks) return;
        for (const hook of this._beforeCallRendererHooks.beforeCallRenderer) {
            await this._mainWindow.webContents.executeJavaScript(`(() => { ${hook(this.id)} })()`);
        }
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
     * Wait for click side-effects (navigation, new tab, DOM mutations) to settle.
     *
     * Strategy (in order):
     * 1. If the click opened a new tab → wait for new tab's page ready
     * 2. If the URL changed (same-tab navigation) → waitForPageReady
     * 3. Otherwise (SPA interaction) → wait for DOM to stabilize via MutationObserver
     * 4. Hard timeout fallback → fixed 500ms delay
     */
    async waitForClickCompletion(session: CDPSession, callback: () => Promise<void>): Promise<void> {
        // Record pre-action state
        let urlBefore: string | null = null;
        let wcIdBefore: number | null = null;
        try {
            const r = await session.send('Runtime.evaluate', {
                expression: 'location.href',
                returnByValue: true
            });
            urlBefore = r.result.value;
            wcIdBefore = session.webContentsId;
        } catch {
            /* page may be in transition */
        }

        await callback();

        // Small delay for the browser to process the event
        await sleep(100);

        // 1) Detect new tab: if webContentsId changed, a new tab was opened and activated
        if (wcIdBefore != null) {
            try {
                const wcIdAfter = await this.callRendererBrowser('browserGetWebContentsId');
                if (wcIdAfter != null && wcIdAfter !== wcIdBefore) {
                    // New tab activated — wait for it to be ready
                    const newSession = await this.getCDPSession();
                    if (newSession) {
                        await newSession.waitForPageReady(8000);
                    }
                    return;
                }
            } catch {
                // Tab detection failed — fall through to URL / DOM checks
            }
        }

        // 2) Same-tab navigation: URL changed
        try {
            const r = await session.send('Runtime.evaluate', {
                expression: 'location.href',
                returnByValue: true
            });
            const urlAfter = r.result.value;
            if (urlAfter !== urlBefore) {
                await session.waitForPageReady(8000);
                return;
            }
        } catch {
            await session.waitForPageReady(8000);
            return;
        }

        // 3) SPA interaction — wait for DOM (menu, dialog, lazy content, animations) to settle
        try {
            await session.waitForDOMStable(5000, 500);
        } catch {
            // MutationObserver couldn't be injected — fallback to fixed delay
            await sleep(500);
        }
    }

    private _makeUploadTargetExpression(target: string): string {
        if (/^e\d+/.test(target)) {
            return `document.querySelector('[data-od-ref="${target}"]')`;
        }
        return `document.querySelector(${JSON.stringify(target)})`;
    }

    private _makeResolveFileInputScript(targetExpression: string, token: string): string {
        return `(async () => {
            var token = ${JSON.stringify(token)};
            var target = ${targetExpression};
            if (!target) return JSON.stringify({ error: 'Upload target not found. Call snapshot to refresh refs.' });

            function isFileInput(el) {
                return !!el && el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'file';
            }
            function textOf(el) {
                return ((el.innerText || el.textContent || el.value || '') + '').replace(/[\\s\\u00A0]+/g, ' ').trim().slice(0, 120);
            }
            function byId(id) {
                if (!id) return null;
                try {
                    return document.getElementById(id);
                } catch(e) {
                    return null;
                }
            }
            function firstFileInput(root) {
                if (!root || !root.querySelector) return null;
                try {
                    return root.querySelector('input[type="file"]');
                } catch(e) {
                    return null;
                }
            }
            function fromIdRefs(value) {
                if (!value) return null;
                var ids = String(value).split(/\\s+/).filter(Boolean);
                for (var i = 0; i < ids.length; i++) {
                    var el = byId(ids[i]);
                    if (isFileInput(el)) return { input: el, strategy: 'idref' };
                    var nested = firstFileInput(el);
                    if (nested) return { input: nested, strategy: 'idref-descendant' };
                }
                return null;
            }
            function fromLabel(label) {
                if (!label || label.tagName !== 'LABEL') return null;
                var forId = label.getAttribute('for');
                var byFor = byId(forId);
                if (isFileInput(byFor)) return { input: byFor, strategy: 'label-for' };
                var nested = firstFileInput(label);
                if (nested) return { input: nested, strategy: 'label-descendant' };
                return null;
            }
            function nearbyFileInput(el) {
                if (isFileInput(el)) return { input: el, strategy: 'target' };

                var labelResult = fromLabel(el);
                if (labelResult) return labelResult;

                if (el.closest) {
                    var closestLabel = el.closest('label');
                    labelResult = fromLabel(closestLabel);
                    if (labelResult) return labelResult;
                }

                var nested = firstFileInput(el);
                if (nested) return { input: nested, strategy: 'descendant' };

                var attrNames = ['aria-controls', 'data-controls', 'data-target', 'data-input', 'for'];
                for (var i = 0; i < attrNames.length; i++) {
                    var idResult = fromIdRefs(el.getAttribute && el.getAttribute(attrNames[i]));
                    if (idResult) return idResult;
                }

                var node = el.parentElement;
                var depth = 0;
                while (node && depth < 6) {
                    nested = firstFileInput(node);
                    if (nested) return { input: nested, strategy: 'ancestor-descendant' };
                    node = node.parentElement;
                    depth++;
                }

                var form = el.closest ? el.closest('form') : null;
                if (form) {
                    var formInputs = form.querySelectorAll('input[type="file"]');
                    if (formInputs.length === 1) return { input: formInputs[0], strategy: 'single-form-input' };
                }

                var allInputs = document.querySelectorAll('input[type="file"]');
                if (allInputs.length === 1) return { input: allInputs[0], strategy: 'single-page-input' };

                return null;
            }
            async function captureProgrammaticFileClick(el) {
                var captured = null;
                var clickError = '';
                var originalClick = HTMLInputElement.prototype.click;
                var originalShowPicker = HTMLInputElement.prototype.showPicker;

                HTMLInputElement.prototype.click = function() {
                    if (isFileInput(this)) {
                        captured = this;
                        return;
                    }
                    return originalClick.apply(this, arguments);
                };
                if (originalShowPicker) {
                    HTMLInputElement.prototype.showPicker = function() {
                        if (isFileInput(this)) {
                            captured = this;
                            return;
                        }
                        return originalShowPicker.apply(this, arguments);
                    };
                }

                try {
                    if (typeof el.click === 'function') el.click();
                    await new Promise(function(resolve) { setTimeout(resolve, 350); });
                } catch(e) {
                    clickError = e && e.message ? e.message : String(e);
                } finally {
                    HTMLInputElement.prototype.click = originalClick;
                    if (originalShowPicker) HTMLInputElement.prototype.showPicker = originalShowPicker;
                }

                if (captured) return { input: captured, strategy: 'captured-click' };
                var afterClick = nearbyFileInput(el);
                if (afterClick) return afterClick;
                if (clickError) return { error: clickError };
                return null;
            }

            var resolved = nearbyFileInput(target);
            if (!resolved) resolved = await captureProgrammaticFileClick(target);
            if (resolved && resolved.error) return JSON.stringify({ error: resolved.error });
            if (!resolved || !resolved.input) {
                return JSON.stringify({
                    error: 'No associated input[type=file] found for this target. Use the file input ref, its label ref, or the upload button ref from a fresh snapshot.'
                });
            }

            var input = resolved.input;
            if (input.disabled) return JSON.stringify({ error: 'The resolved file input is disabled.' });

            input.setAttribute('data-od-upload-token', token);
            return JSON.stringify({
                tag: target.tagName.toLowerCase(),
                text: textOf(target),
                inputRef: input.getAttribute('data-od-ref') || undefined,
                accept: input.getAttribute('accept') || '',
                multiple: !!input.multiple,
                strategy: resolved.strategy
            });
        })()`;
    }

    private _makeDispatchFileInputEventsScript(token: string): string {
        return `(() => {
            var input = document.querySelector('[data-od-upload-token="${token}"]');
            if (!input) return JSON.stringify({ fileCount: null, detachedBeforeEvents: true });
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            var files = Array.prototype.slice.call(input.files || []).map(function(file) {
                return { name: file.name, size: file.size, type: file.type };
            });
            input.removeAttribute('data-od-upload-token');
            return JSON.stringify({ fileCount: files.length, files: files });
        })()`;
    }

    private _makeSyntheticUploadScript(token: string, payloads: BrowserUploadFilePayload[]): string {
        return `(() => {
            var input = document.querySelector('[data-od-upload-token="${token}"]');
            if (!input) return JSON.stringify({ error: 'Resolved file input disappeared before files could be assigned.' });
            if (typeof DataTransfer !== 'function') return JSON.stringify({ error: 'DataTransfer API is not available in this frame.' });
            var payloads = ${JSON.stringify(payloads)};
            var dt = new DataTransfer();
            function base64ToBytes(base64) {
                var binary = atob(base64);
                var bytes = new Uint8Array(binary.length);
                for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                return bytes;
            }
            for (var i = 0; i < payloads.length; i++) {
                var payload = payloads[i];
                var file = new File([base64ToBytes(payload.base64)], payload.name, {
                    type: payload.mimeType,
                    lastModified: payload.lastModified
                });
                dt.items.add(file);
            }
            input.files = dt.files;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            var files = Array.prototype.slice.call(input.files || []).map(function(file) {
                return { name: file.name, size: file.size, type: file.type };
            });
            input.removeAttribute('data-od-upload-token');
            return JSON.stringify({ fileCount: files.length, files: files });
        })()`;
    }

    private _parseResolvedFileInput(raw: unknown): ResolvedFileInput {
        const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!info || typeof info !== 'object') {
            throw new Error('Failed to resolve upload target: empty result');
        }
        const resolved = info as ResolvedFileInput;
        if (resolved.error) throw new Error(resolved.error);
        return resolved;
    }

    private async _resolveUploadInput(
        session: CDPSession,
        target: string,
        token: string
    ): Promise<{ frame: Electron.WebFrameMain | null; input: ResolvedFileInput }> {
        if (/^e\d+/.test(target) && isNestedRef(target)) {
            const { frame, elementRef } = await navigateToFrame(session.webContents.mainFrame, target);
            const script = this._makeResolveFileInputScript(this._makeUploadTargetExpression(elementRef), token);
            const raw = await frame.executeJavaScript(script);
            return { frame, input: this._parseResolvedFileInput(raw) };
        }

        const script = this._makeResolveFileInputScript(this._makeUploadTargetExpression(target), token);
        const result = await session.send('Runtime.evaluate', {
            expression: script,
            awaitPromise: true,
            returnByValue: true
        });
        if (result.exceptionDetails) {
            const msg =
                result.exceptionDetails.text ||
                result.exceptionDetails.exception?.description ||
                'Failed to resolve upload target';
            throw new Error(msg);
        }
        return { frame: null, input: this._parseResolvedFileInput(result.result.value) };
    }

    private async _dispatchUploadEventsInMainFrame(session: CDPSession, token: string): Promise<void> {
        const result = await session.send('Runtime.evaluate', {
            expression: this._makeDispatchFileInputEventsScript(token),
            returnByValue: true
        });
        if (result.exceptionDetails) {
            const msg =
                result.exceptionDetails.text ||
                result.exceptionDetails.exception?.description ||
                'Failed to dispatch upload events';
            throw new Error(msg);
        }
        const info = JSON.parse(result.result.value);
        if (info.error) throw new Error(info.error);
    }

    private async _setFilesViaCDP(session: CDPSession, token: string, filePaths: string[]): Promise<void> {
        const doc = await session.send('DOM.getDocument', { depth: -1, pierce: true });
        const node = await session.send('DOM.querySelector', {
            nodeId: doc.root.nodeId,
            selector: `[data-od-upload-token="${token}"]`
        });
        if (!node.nodeId) {
            throw new Error('Resolved file input disappeared before files could be assigned.');
        }
        await session.send('DOM.setFileInputFiles', {
            nodeId: node.nodeId,
            files: filePaths
        });
        await this._dispatchUploadEventsInMainFrame(session, token);
    }

    private _guessMimeType(filePath: string): string {
        return MIME_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    }

    private async _createSyntheticFilePayloads(filePaths: string[]): Promise<BrowserUploadFilePayload[]> {
        const stats = await Promise.all(filePaths.map((filePath) => fs.stat(filePath)));
        const totalBytes = stats.reduce((sum, stat) => sum + stat.size, 0);
        if (totalBytes > SYNTHETIC_UPLOAD_MAX_BYTES) {
            throw new Error(
                `Cannot upload ${Math.round(totalBytes / 1024 / 1024)} MB through an iframe fallback; target the file input in the main frame or use files under ${Math.round(SYNTHETIC_UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`
            );
        }

        const payloads: BrowserUploadFilePayload[] = [];
        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];
            const buffer = await fs.readFile(filePath);
            payloads.push({
                name: path.basename(filePath),
                mimeType: this._guessMimeType(filePath),
                lastModified: Math.round(stats[i].mtimeMs),
                base64: buffer.toString('base64')
            });
        }
        return payloads;
    }

    private async _setFilesViaSyntheticFrame(
        frame: Electron.WebFrameMain,
        token: string,
        filePaths: string[]
    ): Promise<void> {
        const payloads = await this._createSyntheticFilePayloads(filePaths);
        const raw = await frame.executeJavaScript(this._makeSyntheticUploadScript(token, payloads));
        const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (info?.error) throw new Error(info.error);
    }

    private async _clearUploadToken(
        session: CDPSession,
        frame: Electron.WebFrameMain | null,
        token: string
    ): Promise<void> {
        const script = `(() => {
            var input = document.querySelector('[data-od-upload-token="${token}"]');
            if (input) input.removeAttribute('data-od-upload-token');
        })()`;
        try {
            if (frame) {
                await frame.executeJavaScript(script);
            } else {
                await session.send('Runtime.evaluate', { expression: script });
            }
        } catch {
            /* best effort cleanup */
        }
    }

    private async _describeUploadFiles(
        filePaths: string[]
    ): Promise<Array<{ path: string; name: string; size: number }>> {
        const files: Array<{ path: string; name: string; size: number }> = [];
        for (const filePath of filePaths) {
            const stat = await fs.stat(filePath);
            files.push({
                path: filePath,
                name: path.basename(filePath),
                size: stat.size
            });
        }
        return files;
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
                    const isRef = /^e\d+/.test(target);
                    const targetExpr = isRef
                        ? `document.querySelector('[data-od-ref="${target}"]')`
                        : `document.querySelector(${JSON.stringify(target)})`;

                    if (isRef && isNestedRef(target)) {
                        const { frame, elementRef } = await navigateToFrame(session.webContents.mainFrame, target);
                        await frame
                            .executeJavaScript(
                                `(() => { var el = document.querySelector('[data-od-ref="${elementRef}"]'); if (el) el.click(); })()`
                            )
                            .catch(() => {});
                    } else {
                        await session
                            .send('Runtime.evaluate', {
                                expression: `(() => { var el = ${targetExpr}; if (el) el.click(); })()`,
                                returnByValue: true
                            })
                            .catch(() => {});
                    }
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
            const isRef = /^e\d+/.test(target);
            const isNested = isRef && isNestedRef(target);

            // Click to focus (absolute viewport coords — works for iframe too)
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

            // Resolve target frame for JS execution (clear / read value)
            let targetFrame: Electron.WebFrameMain | null = null;
            let elementRefForFrame: string | null = null;
            if (isNested) {
                const nav = await navigateToFrame(session.webContents.mainFrame, target);
                targetFrame = nav.frame;
                elementRefForFrame = nav.elementRef;
            }

            // Prepare text to input
            let textToInsert = text;

            // In append mode, get current value and concatenate
            if (!clearFirst && text) {
                await sleep(50);
                const readExpr = targetFrame
                    ? `(() => {
                        var el = document.querySelector('[data-od-ref="${elementRefForFrame}"]');
                        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el.value || '';
                        if (el && el.isContentEditable) return el.innerText || el.textContent || '';
                        return '';
                    })()`
                    : `(() => {
                        const el = document.activeElement;
                        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el.value || '';
                        if (el && el.isContentEditable) return el.innerText || el.textContent || '';
                        return '';
                    })()`;

                let currentValue: string;
                if (targetFrame) {
                    currentValue = ((await targetFrame.executeJavaScript(readExpr)) as string) || '';
                } else {
                    const result = await session.send('Runtime.evaluate', {
                        expression: readExpr,
                        returnByValue: true
                    });
                    currentValue = result.result?.value || '';
                }
                textToInsert = currentValue + text;
            }

            // Clear existing text
            const clearExpr = targetFrame
                ? `(() => {
                    var el = document.querySelector('[data-od-ref="${elementRefForFrame}"]');
                    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                        el.value = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (el && el.isContentEditable) {
                        el.textContent = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                })()`
                : `(() => {
                    const el = document.activeElement;
                    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                        el.value = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (el && el.isContentEditable) {
                        el.textContent = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                })()`;

            if (targetFrame) {
                await targetFrame.executeJavaScript(clearExpr);
            } else {
                await session.send('Runtime.evaluate', { expression: clearExpr });
            }
            await sleep(30);

            if (textToInsert) {
                if (targetFrame) {
                    // For iframe: insert text via JS in the target frame.
                    // CDP Input.insertText / Input.dispatchKeyEvent may not route
                    // reliably to cross-origin iframe content.
                    const escapedText = JSON.stringify(textToInsert);
                    if (slowly) {
                        for (const ch of textToInsert) {
                            const chEscaped = JSON.stringify(ch);
                            const kd = resolveKey(ch);
                            const codeEscaped = JSON.stringify(kd.code);
                            await targetFrame.executeJavaScript(
                                `(() => {
                                    var el = document.querySelector('[data-od-ref="${elementRefForFrame}"]');
                                    if (!el) return;
                                    var ch = ${chEscaped};
                                    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                                        var start = el.selectionStart || 0;
                                        var v = el.value || '';
                                        el.value = v.slice(0, start) + ch + v.slice(el.selectionEnd || start);
                                        el.selectionStart = el.selectionEnd = start + ch.length;
                                    } else if (el.isContentEditable) {
                                        document.execCommand('insertText', false, ch);
                                    }
                                    el.dispatchEvent(new KeyboardEvent('keydown', {
                                        key: ch, code: ${codeEscaped}, keyCode: ${kd.keyCode},
                                        shiftKey: ${kd.shiftKey || false},
                                        bubbles: true, cancelable: true
                                    }));
                                    el.dispatchEvent(new KeyboardEvent('keyup', {
                                        key: ch, code: ${codeEscaped}, keyCode: ${kd.keyCode},
                                        shiftKey: ${kd.shiftKey || false},
                                        bubbles: true, cancelable: true
                                    }));
                                    el.dispatchEvent(new Event('input', { bubbles: true }));
                                })()`
                            );
                            await sleep(30);
                        }
                    } else {
                        await targetFrame.executeJavaScript(
                            `(() => {
                                var el = document.querySelector('[data-od-ref="${elementRefForFrame}"]');
                                if (!el) return;
                                var text = ${escapedText};
                                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                                    el.value = text;
                                } else if (el.isContentEditable) {
                                    el.textContent = text;
                                }
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                            })()`
                        );
                    }
                } else if (slowly) {
                    for (const ch of textToInsert) {
                        const desc = resolveKey(ch);
                        const baseEvent = {
                            key: desc.key,
                            code: desc.code,
                            windowsVirtualKeyCode: desc.keyCode
                        };
                        const modifiersVal = desc.shiftKey ? 8 : 0;
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyDown',
                            ...baseEvent,
                            modifiers: modifiersVal,
                            text: desc.text || ''
                        });
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyUp',
                            ...baseEvent,
                            modifiers: modifiersVal
                        });
                        await sleep(30);
                    }
                } else {
                    await session.send('Input.insertText', { text: textToInsert });
                }
            }

            if (submit) {
                await sleep(50);
                if (targetFrame) {
                    await targetFrame.executeJavaScript(
                        `(() => {
                            var el = document.querySelector('[data-od-ref="${elementRefForFrame}"]');
                            if (!el) return;
                            el.dispatchEvent(new KeyboardEvent('keydown', {
                                key: 'Enter', code: 'Enter', keyCode: 13,
                                bubbles: true, cancelable: true
                            }));
                            el.dispatchEvent(new KeyboardEvent('keyup', {
                                key: 'Enter', code: 'Enter', keyCode: 13,
                                bubbles: true, cancelable: true
                            }));
                            var form = el.closest('form');
                            if (form) form.submit();
                        })()`
                    );
                } else {
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

    async pressKey(key: string, modifiers?: string[], iframeRef?: string): Promise<{ key: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const keyDesc = resolveKey(key);
            const modMask = modifiersBitmask(modifiers);
            const isPlainTab = keyDesc.key === 'Tab' && (modMask & 7) === 0;
            await this._focusActiveWebviewForKeyboard(session);

            if (iframeRef) {
                if (isPlainTab) {
                    const frame = await navigateIntoFrame(session.webContents.mainFrame, iframeRef);
                    await frame.executeJavaScript(this._makePressTabInDocumentScript((modMask & 8) !== 0));
                    return { key };
                }

                // When focus is inside an iframe, CDP Input.dispatchKeyEvent may not
                // route correctly.  Dispatch synthetic KeyboardEvent in the iframe.
                const frame = await navigateIntoFrame(session.webContents.mainFrame, iframeRef);
                const ctrlKey = (modMask & 2) !== 0;
                const altKey = (modMask & 1) !== 0;
                const shiftKey = (modMask & 8) !== 0;
                const metaKey = (modMask & 4) !== 0;
                await frame.executeJavaScript(
                    `(() => {
                        var el = document.activeElement || document.body;
                        var opts = {
                            key: ${JSON.stringify(keyDesc.key)},
                            code: ${JSON.stringify(keyDesc.code)},
                            keyCode: ${keyDesc.keyCode},
                            which: ${keyDesc.keyCode},
                            bubbles: true, cancelable: true, view: window,
                            ctrlKey: ${ctrlKey}, altKey: ${altKey},
                            shiftKey: ${shiftKey}, metaKey: ${metaKey}
                        };
                        el.dispatchEvent(new KeyboardEvent('keydown', opts));
                        el.dispatchEvent(new KeyboardEvent('keyup', opts));
                        ${
                            keyDesc.text
                                ? `if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
                            var start = el.selectionStart;
                            var end = el.selectionEnd;
                            var v = el.value || el.textContent || '';
                            el.value = v.slice(0, start) + ${JSON.stringify(keyDesc.text)} + v.slice(end);
                            el.selectionStart = el.selectionEnd = start + ${keyDesc.text.length};
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                        }`
                                : ''
                        }
                    })()`
                );
            } else if (isPlainTab) {
                await session.send('Runtime.evaluate', {
                    expression: this._makePressTabInDocumentScript((modMask & 8) !== 0),
                    returnByValue: true
                });
            } else {
                const text = (modMask & 7) === 0 ? keyDesc.text || '' : '';
                const keyDownType = text ? 'keyDown' : 'rawKeyDown';
                await session.send('Input.dispatchKeyEvent', {
                    type: keyDownType,
                    key: keyDesc.key,
                    code: keyDesc.code,
                    windowsVirtualKeyCode: keyDesc.keyCode,
                    nativeVirtualKeyCode: keyDesc.keyCode,
                    text,
                    modifiers: modMask
                });
                await session.send('Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    key: keyDesc.key,
                    code: keyDesc.code,
                    windowsVirtualKeyCode: keyDesc.keyCode,
                    nativeVirtualKeyCode: keyDesc.keyCode,
                    modifiers: modMask
                });
            }

            return { key };
        });
    }

    async selectOption(target: string, values: string[]): Promise<{ selected: string[] }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const valuesJSON = JSON.stringify(values);

            const isRef = /^e\d+/.test(target);

            let resultValue: string;

            if (isRef && isNestedRef(target)) {
                const { frame, elementRef } = await navigateToFrame(session.webContents.mainFrame, target);
                const targetSelectJS = `(() => {
                    var el = document.querySelector('[data-od-ref="${elementRef}"]');
                    if (!el) return JSON.stringify({ error: 'Element not found' });
                    if (el.tagName.toLowerCase() !== 'select') return JSON.stringify({ error: 'Element is not a <select>' });
                    var values = ${valuesJSON};
                    for (var i = 0; i < el.options.length; i++) {
                        el.options[i].selected = values.indexOf(el.options[i].value) !== -1;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return JSON.stringify({ selected: values });
                })()`;
                resultValue = (await frame.executeJavaScript(targetSelectJS)) as string;
            } else {
                const selectorExpr = isRef
                    ? `document.querySelector('[data-od-ref="${target}"]')`
                    : `document.querySelector(${JSON.stringify(target)})`;
                const selectJS = `(() => {
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
                })()`;
                const result = await session.send('Runtime.evaluate', {
                    expression: selectJS,
                    returnByValue: true
                });
                resultValue = result.result.value;
            }

            const info = JSON.parse(resultValue);
            if (info.error) throw new Error(info.error);
            return info;
        });
    }

    async uploadFile(target: string, filePaths: string[]): Promise<BrowserUploadFileResult> {
        if (filePaths.length === 0) {
            throw new Error('No files specified for upload.');
        }

        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const token = `od-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const { frame, input } = await this._resolveUploadInput(session, target, token);

            try {
                if (!input.multiple && filePaths.length > 1) {
                    throw new Error('The resolved file input does not allow multiple files.');
                }

                if (frame) {
                    await this._setFilesViaSyntheticFrame(frame, token, filePaths);
                } else {
                    await this._setFilesViaCDP(session, token, filePaths);
                }

                await sleep(250);
                const pageState = await this.readPageState(session);
                return {
                    target,
                    tag: input.tag,
                    text: input.text,
                    ...(input.inputRef && { inputRef: input.inputRef }),
                    accept: input.accept,
                    multiple: input.multiple,
                    files: await this._describeUploadFiles(filePaths),
                    ...(pageState && { page: pageState })
                };
            } catch (err) {
                await this._clearUploadToken(session, frame, token);
                throw err;
            }
        });
    }

    async scrollTo(
        ref: string,
        options: {
            block?: 'start' | 'center' | 'end' | 'nearest';
            inline?: 'start' | 'center' | 'end' | 'nearest';
        } = {}
    ): Promise<{ ref: string; tag: string; text: string }> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();
            const block = options.block || 'nearest';
            const inline = options.inline || 'nearest';

            // Nested ref (e.g. "e5-e3") — navigate into iframe chain
            if (isNestedRef(ref)) {
                const { frame, elementRef } = await navigateToFrame(session.webContents.mainFrame, ref);
                const result = (await frame.executeJavaScript(`
                    (() => {
                        var el = document.querySelector('[data-od-ref="${elementRef}"]');
                        if (!el) return JSON.stringify({ error: 'Element not found: ${elementRef}' });
                        el.scrollIntoView({ block: '${block}', inline: '${inline}', behavior: 'instant' });
                        return JSON.stringify({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80) });
                    })()
                `)) as string;
                const info = JSON.parse(result);
                if (info.error) throw new Error(info.error);
                return { ref, tag: info.tag, text: info.text };
            }

            // Simple ref — scroll in main frame
            const result = await session.send('Runtime.evaluate', {
                expression: `(() => {
                    var el = document.querySelector('[data-od-ref="${ref}"]');
                    if (!el) return JSON.stringify({ error: 'Element not found: ${ref}' });
                    el.scrollIntoView({ block: '${block}', inline: '${inline}', behavior: 'instant' });
                    return JSON.stringify({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().substring(0, 80) });
                })()`,
                returnByValue: true,
                awaitPromise: true
            });

            if (result.exceptionDetails) {
                const msg =
                    result.exceptionDetails.text ||
                    result.exceptionDetails.exception?.description ||
                    'scrollTo evaluation error';
                throw new Error(msg);
            }

            const info = JSON.parse(result.result.value);
            if (info.error) throw new Error(info.error);
            return { ref, tag: info.tag, text: info.text };
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

    async evaluate(expression: string, iframeRef?: string): Promise<any> {
        return this._withExclusiveLock(async () => {
            const session = await this.requireCDP();

            if (iframeRef) {
                const frame = await navigateIntoFrame(session.webContents.mainFrame, iframeRef);
                const rawResult = await frame.executeJavaScript(expression);
                return rawResult;
            }

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

    async waitFor(options: {
        text?: string;
        textGone?: string;
        timeout?: number;
        iframeRef?: string;
    }): Promise<{ condition: string }> {
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

            // Resolve target frame once (iframe doesn't change during polling)
            let targetFrame: Electron.WebFrameMain | null = null;
            if (options.iframeRef) {
                targetFrame = await navigateIntoFrame(session.webContents.mainFrame, options.iframeRef);
            }

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
                    let found: boolean;
                    if (targetFrame) {
                        found = (await targetFrame.executeJavaScript(checkExpr)) as boolean;
                    } else {
                        const result = await session.send('Runtime.evaluate', {
                            expression: checkExpr,
                            returnByValue: true
                        });
                        found = result.result.value === true;
                    }
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
    private static _beforeCallRendererHooks: BrowserScriptGenerators | undefined;

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
            ctrl = new BrowserController(
                id,
                mainWindow ?? BrowserManager._mainWindow,
                BrowserManager._beforeCallRendererHooks
            );
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
    static async initSession(partition: string = 'persist:opendesk-browser'): Promise<Electron.Session | null> {
        try {
            // Dynamic import to avoid requiring electron at module load time
            const { session } = await import('electron');
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
     *
     * @param ipcMain Electron IPC main instance
     * @param beforeCallRendererHooks 脚本生成器，包含在调用 renderer 桥接前执行的 hook 列表
     */
    static bind(
        ipcMain: { handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void },
        beforeCallRendererHooks?: BrowserScriptGenerators
    ): void {
        if (BrowserManager._bound) return;
        BrowserManager._bound = true;
        BrowserManager._beforeCallRendererHooks = beforeCallRendererHooks;

        const runBeforeCallRendererHooks = async (taskId: string): Promise<void> => {
            if (!BrowserManager._mainWindow || !BrowserManager._beforeCallRendererHooks) return;
            for (const hook of BrowserManager._beforeCallRendererHooks.beforeCallRenderer) {
                await BrowserManager._mainWindow.webContents.executeJavaScript(`(() => { ${hook(taskId)} })()`);
            }
        };

        const callBrowserOnTask = async (taskId: string, method: string, ...args: unknown[]): Promise<IPCResponse> => {
            if (!BrowserManager._mainWindow) {
                return { status: 'error', message: 'No main window' };
            }
            try {
                await runBeforeCallRendererHooks(taskId);
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
                await runBeforeCallRendererHooks(taskId);
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
