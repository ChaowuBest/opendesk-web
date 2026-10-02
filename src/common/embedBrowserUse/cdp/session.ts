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

import type { WebFrameMain } from 'electron';

/**
 * embedBrowserUse — CDP session management.
 *
 * Wraps Electron's webContents.debugger API into a clean async CDP session.
 * Handles automatic reconnection: if the debugger detaches (e.g. during
 * page reload), the session transparently re-attaches on the next send().
 */

/** Pluggable logger interface — avoids hard dependency on project-specific logger. */
export interface CDPLogger {
    warn(msg: string): void;
    error(msg: string): void;
    info?(msg: string): void;
}

let _logger: CDPLogger = {
    warn: (msg: string) => console.warn(`[CDP] ${msg}`),
    error: (msg: string) => console.error(`[CDP] ${msg}`)
};

/** Override the default console logger with a project-specific one. */
export function setCDPLogger(l: CDPLogger): void {
    _logger = l;
}

export interface NestedJSResult {
    mainResult: unknown;
    frameResults: Record<string, NestedJSResult>;
}

/**
 * 默认 CDP 命令超时。debugger.sendCommand 在页面导航竞态 / debugger 中途
 * detach / webview 状态异常时可能永久挂起，必须限时失败并重建连接，
 * 否则一次挂起的命令会让整个 controller 的独占锁队列永久阻塞。
 */
export const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 20000;

export class CDPSession {
    private _wc: Electron.WebContents;
    private _attached = false;
    /** Disposed sessions must never re-attach or send — prevents a wedged
     * operation's orphaned session from "resurrecting" onto a fresh debugger
     * connection and interleaving commands with the next locked operation. */
    private _disposed = false;
    private _enabledDomains = new Set<string>();
    private _eventHandlers = new Map<string, Set<(params: any) => void>>();
    /** Guard: only one set of native listeners per webContents */
    private _nativeListenersBound = false;
    /** Bound references for removal */
    private _onMessage: ((event: any, method: string, params: any) => void) | null = null;
    private _onDetach: ((event: any, reason: string) => void) | null = null;

    private constructor(webContents: Electron.WebContents) {
        this._wc = webContents;
    }

    /**
     * Create and attach a CDP session to the given webContents.
     */
    static async create(webContents: Electron.WebContents): Promise<CDPSession> {
        const session = new CDPSession(webContents);
        session._bindNativeListeners();
        await session._ensureAttached();
        return session;
    }

    /** Attach native debugger event listeners (once per session lifetime). */
    private _bindNativeListeners(): void {
        if (this._nativeListenersBound) return;
        this._nativeListenersBound = true;

        const dbg = this._wc.debugger;

        this._onMessage = (_event: any, method: string, params: any) => {
            const handlers = this._eventHandlers.get(method);
            if (handlers) {
                for (const h of handlers) {
                    try {
                        h(params);
                    } catch (e) {
                        _logger.error(`CDP event handler error: ${e}`);
                    }
                }
            }
        };

        this._onDetach = (_event: any, reason: string) => {
            _logger.warn(`CDP debugger detached: ${reason}`);
            this._attached = false;
            this._enabledDomains.clear();
            // Don't clear _eventHandlers — they belong to the logical session
            // and will be re-used after reconnection.
        };

        dbg.on('message', this._onMessage);
        dbg.on('detach', this._onDetach);
    }

    /** Remove native listeners (on dispose). */
    private _unbindNativeListeners(): void {
        if (!this._nativeListenersBound) return;
        this._nativeListenersBound = false;

        const dbg = this._wc.debugger;
        if (this._onMessage) {
            dbg.removeListener('message', this._onMessage);
            this._onMessage = null;
        }
        if (this._onDetach) {
            dbg.removeListener('detach', this._onDetach);
            this._onDetach = null;
        }
    }

    /**
     * Ensure the debugger is attached, re-attaching if needed.
     * This is the core reconnection mechanism.
     */
    private async _ensureAttached(): Promise<void> {
        if (this._disposed) {
            throw new Error('CDP session is disposed — reattach not allowed');
        }
        if (this._attached && !this._wc.isDestroyed()) return;

        if (this._wc.isDestroyed()) {
            throw new Error('WebContents is destroyed — cannot attach CDP');
        }

        const dbg = this._wc.debugger;
        if (!dbg.isAttached()) {
            try {
                dbg.attach('1.3');
            } catch (err: any) {
                throw new Error(`Failed to attach CDP debugger: ${err.message || err}`);
            }
        }

        this._attached = true;
        // Domain enables are lost after detach; clear so they get re-enabled on demand
        this._enabledDomains.clear();
    }

    get attached(): boolean {
        return this._attached && !this._wc.isDestroyed();
    }

    get webContentsId(): number {
        return this._wc.id;
    }

    /** Access the underlying Electron WebContents (e.g. for frame tree navigation). */
    get webContents(): Electron.WebContents {
        return this._wc;
    }

    /**
     * Send a CDP command.
     * Automatically re-attaches the debugger if it was detached (e.g. by reload).
     * Bounded by a timeout: a wedged sendCommand (navigation race, mid-detach,
     * frozen guest renderer) must fail instead of hanging forever.
     */
    async send(
        method: string,
        params?: Record<string, any>,
        timeoutMs: number = DEFAULT_CDP_COMMAND_TIMEOUT_MS
    ): Promise<any> {
        if (this._disposed) {
            throw new Error(`CDP session is disposed — cannot send ${method}`);
        }
        await this._ensureAttached();
        try {
            return await this._sendCommandWithTimeout(method, params ?? {}, timeoutMs);
        } catch (err: any) {
            // If the send failed due to a stale attachment, try once more
            const msg = String(err.message || err);
            if (
                msg.includes('not attached') ||
                msg.includes('Debugger is not attached') ||
                msg.includes('Target closed')
            ) {
                this._attached = false;
                await this._ensureAttached();
                return this._sendCommandWithTimeout(method, params ?? {}, timeoutMs);
            }
            throw err;
        }
    }

    /**
     * Run debugger.sendCommand bounded by a timeout. On expiry the debugger is
     * detached and marked unattached so the next send() re-attaches cleanly
     * instead of continuing to hang on the same wedged connection.
     */
    private async _sendCommandWithTimeout(
        method: string,
        params: Record<string, any>,
        timeoutMs: number
    ): Promise<any> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this._wc.debugger.sendCommand(method, params),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        // In-flight command is hopeless — reset the connection so
                        // the next send re-attaches a fresh debugger session.
                        this._attached = false;
                        // Domain state is tied to the attachment; clear it explicitly
                        // (do not rely on the detach event firing for manual detach).
                        this._enabledDomains.clear();
                        try {
                            if (!this._wc.isDestroyed() && this._wc.debugger.isAttached()) {
                                this._wc.debugger.detach();
                            }
                        } catch {
                            // already detached / destroyed
                        }
                        reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`));
                    }, timeoutMs);
                })
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    /**
     * Enable a CDP domain (idempotent within the current attachment).
     */
    async enableDomain(domain: string): Promise<void> {
        if (this._enabledDomains.has(domain)) return;
        await this.send(`${domain}.enable`);
        this._enabledDomains.add(domain);
    }

    /**
     * Lightweight probe to check if the session is responsive.
     * Returns true if Runtime.evaluate succeeds, false otherwise.
     */
    async isHealthy(): Promise<boolean> {
        try {
            const result = await this.send('Runtime.evaluate', {
                expression: '1+1',
                returnByValue: true
            });
            return result?.result?.value === 2;
        } catch {
            return false;
        }
    }

    /**
     * Wait until the page's JS context is ready (e.g. after navigation / reload).
     * Polls Runtime.evaluate with exponential backoff.
     *
     * Each probe is individually bounded so one wedged sendCommand cannot freeze
     * the whole poll loop past its deadline.
     */
    async waitForPageReady(timeoutMs: number = 15000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        // Single-probe cap: short enough to stay well under the overall deadline.
        const probeTimeoutMs = 5000;
        const delays = [100, 200, 300, 500, 800, 1000, 1500, 2000, 2000, 2000, 2000];
        let attempt = 0;

        while (Date.now() < deadline) {
            try {
                // _ensureAttached first in case debugger detached during reload
                await this._ensureAttached();
                const result = await this._sendCommandWithTimeout(
                    'Runtime.evaluate',
                    {
                        expression: 'document.readyState',
                        returnByValue: true
                    },
                    probeTimeoutMs
                );
                const state = result?.result?.value;
                if (state === 'complete' || state === 'interactive') {
                    return;
                }
            } catch {
                // Page not ready yet — swallow and retry
                this._attached = false;
            }

            const delay = delays[Math.min(attempt, delays.length - 1)];
            await new Promise((r) => setTimeout(r, delay));
            attempt++;
        }
        // Don't throw — best effort; the page may still become ready shortly after
        _logger.warn(`waitForPageReady: timed out after ${timeoutMs}ms (page may still be loading)`);
    }

    /**
     * Wait for the page DOM to stabilize after an interaction.
     *
     * Injects a MutationObserver into the page. Resolves when no DOM mutations
     * have occurred for `stableThresholdMs` milliseconds, or when the overall
     * `timeoutMs` is reached (whichever comes first).
     *
     * This is intended for SPA interactions that do not cause navigation:
     * dropdown menus, modal dialogs, lazy-loaded lists, CSS-triggered
     * animations that mutate the DOM, etc.
     *
     * @param timeoutMs         Maximum time to wait (default 5000ms).
     * @param stableThresholdMs Quiet period required to consider the DOM stable (default 500ms).
     */
    async waitForDOMStable(timeoutMs: number = 5000, stableThresholdMs: number = 500): Promise<void> {
        const script = `
            new Promise((resolve) => {
                if (!document.body) { resolve(); return; }
                var _timer;
                var _observer = new MutationObserver(function() {
                    clearTimeout(_timer);
                    _timer = setTimeout(function() {
                        _observer.disconnect();
                        resolve();
                    }, ${stableThresholdMs});
                });
                _observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    characterData: true
                });
                // Start the quiet-period timer immediately
                _timer = setTimeout(function() {
                    _observer.disconnect();
                    resolve();
                }, ${stableThresholdMs});
                // Hard timeout — never block forever
                setTimeout(function() {
                    _observer.disconnect();
                    resolve();
                }, ${timeoutMs});
            })
        `;

        try {
            await this.send('Runtime.evaluate', {
                expression: script,
                awaitPromise: true,
                returnByValue: true
            });
        } catch {
            // If the page context is gone (navigation in progress), just return
        }
    }

    /**
     * Register a handler for a CDP event (e.g. 'Page.frameStoppedLoading').
     */
    on(method: string, handler: (params: any) => void): void {
        let handlers = this._eventHandlers.get(method);
        if (!handlers) {
            handlers = new Set();
            this._eventHandlers.set(method, handlers);
        }
        handlers.add(handler);
    }

    /**
     * Remove a handler for a CDP event.
     */
    off(method: string, handler: (params: any) => void): void {
        const handlers = this._eventHandlers.get(method);
        if (handlers) {
            handlers.delete(handler);
            if (handlers.size === 0) this._eventHandlers.delete(method);
        }
    }

    /**
     * Wait for a specific CDP event, with timeout.
     */
    waitForEvent(method: string, timeoutMs: number = 30000): Promise<any> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.off(method, handler);
                reject(new Error(`Timeout waiting for CDP event: ${method}`));
            }, timeoutMs);

            const handler = (params: any) => {
                clearTimeout(timer);
                this.off(method, handler);
                resolve(params);
            };

            this.on(method, handler);
        });
    }

    /**
     * Dispose the session: detach debugger and clean up listeners.
     * After disposal the session is permanently unusable (send/reattach throw).
     */
    dispose(): void {
        this._disposed = true;
        this._unbindNativeListeners();
        if (this._attached && !this._wc.isDestroyed()) {
            try {
                this._wc.debugger.detach();
            } catch {
                // Already detached or destroyed
            }
        }
        this._attached = false;
        this._enabledDomains.clear();
        this._eventHandlers.clear();
    }

    async executeJavaScriptOnAllFrames(code: string, frame?: WebFrameMain): Promise<NestedJSResult> {
        const root = frame ?? this._wc.mainFrame;
        const result: NestedJSResult = {
            mainResult: await root.executeJavaScript(code),
            frameResults: {}
        };
        for (const frame of root.frames) {
            try {
                result.frameResults[frame.frameToken] = await this.executeJavaScriptOnAllFrames(code, frame);
            } catch (err) {
                _logger.error(`failed to execute javascript on frame ${frame.frameTreeNodeId}`);
            }
        }
        return result;
    }
}

/**
 * Manages CDP sessions keyed by webContentsId.
 * Sessions auto-reconnect; the manager handles lifecycle and health checks.
 */
export class CDPSessionManager {
    private _sessions = new Map<number, CDPSession>();

    /**
     * Get or create a healthy CDP session for the given webContentsId.
     *
     * If a cached session exists but is unhealthy, it is disposed and replaced.
     */
    async getSession(webContentsId: number): Promise<CDPSession> {
        const existing = this._sessions.get(webContentsId);
        if (existing) {
            // Fast path: session's auto-reconnect in send() should handle most cases.
            // But verify the webContents is still alive.
            try {
                if (!existing.attached) {
                    // Let send()'s _ensureAttached try to reconnect.
                    // Probe health to confirm it actually works.
                    const healthy = await existing.isHealthy();
                    if (healthy) return existing;
                }
                // attached flag is true — trust it (send() will retry on failure)
                if (existing.attached) return existing;
            } catch {
                // Fall through to recreate
            }

            // Session unrecoverable — dispose and recreate
            existing.dispose();
            this._sessions.delete(webContentsId);
        }

        // Resolve webContents from ID
        const { webContents } = await import('electron');
        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) {
            throw new Error(`WebContents ${webContentsId} not found or destroyed`);
        }

        const session = await CDPSession.create(wc);
        this._sessions.set(webContentsId, session);
        return session;
    }

    /**
     * Dispose and remove a specific session.
     */
    dispose(webContentsId: number): void {
        const session = this._sessions.get(webContentsId);
        if (session) {
            session.dispose();
            this._sessions.delete(webContentsId);
        }
    }

    /**
     * Dispose all sessions.
     */
    disposeAll(): void {
        for (const [, session] of this._sessions) {
            session.dispose();
        }
        this._sessions.clear();
    }
}
