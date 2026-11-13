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

/** 取当前 CDP 日志器：库内其他模块（如 IPC handler）复用宿主注入的同一份 logger。 */
export function getCDPLogger(): CDPLogger {
    return _logger;
}

export interface NestedJSResult {
    mainResult: unknown;
    frameResults: Record<string, NestedJSResult>;
    /** 该 frame 的脚本执行失败（如加载失败、执行上下文销毁）时的错误信息 */
    error?: string;
}

/** 一次 JS 对话框（alert/confirm/prompt/beforeunload）的信息，供操作结果回显。 */
export interface JavaScriptDialogInfo {
    /** 对话框类型：alert / confirm / prompt / beforeunload */
    type: string;
    /** 对话框文本 */
    message: string;
    /** 触发对话框的页面 URL */
    url?: string;
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
    /** 本次会话是否由自己 attach 了 webContents.debugger。
     * webContents 上只有一条 CDP 连接，可能被多个 CDPSession 共享
     * （先到者 attach，后来者复用）。只有 attach 的发起者才允许 detach，
     * 否则一次性会话（如导出 snapshot）结束时会把别人正在用的连接踢掉。 */
    private _ownsAttachment = false;
    /** 共享连接上的命令超时后置位：那一刻不能立刻 detach（会打断连接所有者的
     * 在途命令），改为等本会话下一次真的要发命令时再重置连接并接管。 */
    private _needsFreshConnection = false;
    /** Disposed sessions must never re-attach or send — prevents a wedged
     * operation's orphaned session from "resurrecting" onto a fresh debugger
     * connection and interleaving commands with the next locked operation. */
    private _disposed = false;
    private _enabledDomains = new Set<string>();
    private _eventHandlers = new Map<string, Set<(params: any) => void>>();
    /** Guard: only one set of native listeners per webContents */
    private _nativeListenersBound = false;
    /** JS 对话框事件处理器是否已注册（按会话生命周期一次，重连只重新 enable Page 域） */
    private _dialogHandlerInstalled = false;
    /** 最近一次被自动处理的 JS 对话框（takeLastDialog 消费后清空） */
    private _lastDialog: JavaScriptDialogInfo | null = null;
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
        try {
            session._bindNativeListeners();
            await session._ensureAttached();
        } catch (err) {
            // 建链失败时调用方拿不到 session，无法 dispose：必须在这里收回
            // 已注册的 message/detach 监听。否则每失败一次（如 DevTools 已占用
            // debugger 导致 attach 抛错）就在 webContents.debugger 上多留一组
            // 闭包，随页面存活一直挂着。
            session.dispose();
            throw err;
        }
        return session;
    }

    /** 丢弃当前连接的内存状态：清掉 attached / ownership / 已 enable 的域。
     * 返回丢弃前是否由本会话持有这条连接（决定能否 detach）。 */
    private _dropAttachmentState(): boolean {
        const owned = this._ownsAttachment;
        this._attached = false;
        this._ownsAttachment = false;
        this._enabledDomains.clear();
        return owned;
    }

    /** 连接是否确实已经不存在（webContents 已销毁也视为不存在）。 */
    private _isAttachmentGone(): boolean {
        try {
            return this._wc.isDestroyed() || !this._wc.debugger.isAttached();
        } catch {
            return true;
        }
    }

    /**
     * 命令超时等「连接已不可信」时的处理。
     *
     * 本会话持有的连接：立即 detach，让下一次 send 重新 attach 一条干净的连接。
     * 共享连接（由别的会话 attach）：那一刻不能 detach（会打断对方在途命令），
     * 只标记待重建，等本会话下一次真的要发命令时再重置接管。
     */
    private _discardConnection(): void {
        if (this._dropAttachmentState()) {
            try {
                if (!this._wc.isDestroyed() && this._wc.debugger.isAttached()) {
                    this._wc.debugger.detach();
                }
            } catch {
                // already detached / destroyed
            }
            return;
        }
        this._needsFreshConnection = true;
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
            // 域状态与具体连接绑定：无论事件是否过期都清掉，下次用到时重新 enable。
            this._enabledDomains.clear();
            // 事件可能在本会话已经重新 attach 之后才到达（超时重置后立刻重建）。
            // 此时 debugger 实际仍处于连接状态，不能把内存标记改回断开——否则会
            // 一并丢掉 ownership，dispose 时漏掉 detach，连接会永久挂在页面上
            // （此后任何新的 attach 都会抛 "Debugger is already attached"）。宁可
            // 保留 ownership：最坏情况是多 detach 一次刚被别人建立的连接，而对方
            // 会在 send() 的连接失效重试路径里自动重连。
            try {
                if (this._wc.debugger.isAttached()) {
                    // 迟到的 detach 事件对应的那条（已挂死的）连接确实不在了，
                    // 待重建标记随之失效；否则下一次 send 会把别人刚建好的健康
                    // 连接再 detach 一次。
                    this._needsFreshConnection = false;
                    return;
                }
            } catch {
                // webContents 已销毁 → 按断开处理
            }
            this._dropAttachmentState();
            this._needsFreshConnection = false;
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
        // 上一次命令超时发生在共享连接上：当时没有立刻 detach（避免打断连接
        // 所有者的在途命令）。现在本会话确实需要一条能用的连接，才重置这条已
        // 证明挂死的连接并接管；其他会话会在 send() 的连接失效重试路径里自动
        // 重新 attach。
        if (this._needsFreshConnection) {
            this._needsFreshConnection = false;
            try {
                if (dbg.isAttached()) dbg.detach();
            } catch {
                // 已 detach / webContents 已销毁
            }
        }
        if (!dbg.isAttached()) {
            try {
                dbg.attach('1.3');
            } catch (err: any) {
                throw new Error(`Failed to attach CDP debugger: ${err.message || err}`);
            }
            // 这条 attach 由本会话发起，dispose 时由本会话负责 detach。
            this._ownsAttachment = true;
        }

        this._attached = true;
        // Domain enables are lost after detach; clear so they get re-enabled on demand
        this._enabledDomains.clear();
    }

    /**
     * Enable Page domain and auto-handle JS dialogs on the current connection.
     *
     * 为什么不由 attach 自动 enable：CDP 域的 enable 与具体连接绑定，导航后重连
     * 的时机不可控，而对话框只可能由 click/type/evaluate 等操作触发——在动作
     * 入口显式调用本方法（幂等）即可保证对话框接管先于动作生效，也不会拖慢
     * 每次重连。
     *
     * 未接管时的历史行为：alert 由 Electron 自动关闭；confirm()/prompt() 会把
     * 在途的 frame.executeJavaScript 永久挂起，直到独占锁看门狗超时并重置会话。
     * 自动 accept 与 alert 的既有自动行为一致，并记录对话框信息供结果回显。
     *
     * 平台限制：Electron 的 JS dialog manager 不实现 prompt —— 页面调用
     * window.prompt() 会直接抛 "prompt() is not supported."，既不会产生
     * Page.javascriptDialogOpening，也不会有 dialog 回显或挂起。判断"有没有弹框"
     * 时不要期待 prompt 的相关信息。
     */
    async ensureDialogHandling(): Promise<void> {
        if (!this._dialogHandlerInstalled) {
            this._dialogHandlerInstalled = true;
            this.on('Page.javascriptDialogOpening', (params: any) => {
                this._lastDialog = {
                    type: String(params?.type ?? 'unknown'),
                    message: String(params?.message ?? ''),
                    url: typeof params?.url === 'string' ? params.url : undefined
                };
                // 必须应答，否则 renderer 会一直等对话框关闭；accept 让
                // confirm 流程能继续走完（与超时看门狗重置后的历史结局一致）。
                this._sendCommandWithTimeout('Page.handleJavaScriptDialog', { accept: true }, 5000).catch(() => {
                    /* 对话框可能已被页面/用户关闭 */
                });
            });
        }
        if (this._enabledDomains.has('Page')) return;
        try {
            await this.enableDomain('Page');
        } catch {
            // Page 域不可用（target 刚销毁等）：退回无对话框接管的历史行为。
        }
    }

    /**
     * 取出并清空最近一次自动处理的 JS 对话框信息。
     * 操作（click/type/evaluate 等）完成后调用，用于在结果中提示 agent
     * "页面弹了对话框、已被自动接受"。
     */
    takeLastDialog(): JavaScriptDialogInfo | null {
        const dialog = this._lastDialog;
        this._lastDialog = null;
        return dialog;
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
            // If the send failed due to a stale attachment, try once more.
            //
            // 失效文案来自两侧且大小写不一致：Electron 侧是 "No target available"
            // （连接已不存在）与 "target closed while handling command"（命令在途
            // 被 detach），浏览器侧是 "Debugger is not attached ..." / "Target
            // closed"。统一转小写比较 —— 只差一个大小写，这条恢复路径就整条失效，
            // 调用方会拿到一条对自己毫无意义的错误而不是重连后的结果。
            const msg = String(err.message || err).toLowerCase();
            if (msg.includes('not attached') || msg.includes('target closed') || msg.includes('no target available')) {
                // 报错本身说明本会话声称的那条连接已经没了：这里只丢弃 ownership
                // 记账，不按 owner 去 detach —— 此刻的原生连接可能已被别的会话
                // 重建，detach 会打断它。是否需要重新 attach 由 _ensureAttached
                // 按当前真实状态判断。
                this._dropAttachmentState();
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
                        this._discardConnection();
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
                // Page not ready yet — swallow and retry.
                //
                // 探测失败在导航中是常态（Runtime.evaluate 会报 execution context
                // destroyed），不代表连接坏了：这里只清「本会话当前可用」标记，
                // 让下一轮重新校验，绝不当场 detach —— 否则导航期间每轮探测都会
                // 拆一次连接（还在 Page.enable 状态下丢 CDP 事件）。
                //
                // ownership 只在连接确实已经不存在时一并清掉：连接还在就仍归本
                // 会话负责（Electron 不提供连接身份，记账一旦丢失就再也认领不回来，
                // 连接会永久挂在页面上没人 detach）。
                this._attached = false;
                if (this._isAttachmentGone()) {
                    this._dropAttachmentState();
                }
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
        // 清理路径（destroyed 兜底、removeController）可能作用于已销毁的
        // webContents；dispose 必须保证完整执行、绝不抛出，否则会打断
        // removeController → 任务删除的调用链。
        try {
            this._unbindNativeListeners();
        } catch {
            // webContents 已销毁时原生属性访问可能抛出，忽略即可
        }
        // 只 detach 由本会话 attach 的连接：共享连接（debugger 已被别的会话
        // 占用时复用）上的 detach 会打断对方正在进行的 CDP 操作。
        const owned = this._dropAttachmentState();
        this._needsFreshConnection = false;
        if (owned && !this._wc.isDestroyed()) {
            try {
                if (this._wc.debugger.isAttached()) this._wc.debugger.detach();
            } catch {
                // Already detached or destroyed
            }
        }
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
            } catch (err: any) {
                // 失败的 frame 不能静默丢弃（会渲染成与"空内容"无法区分的一行
                // 摘要，BUG-26）：记录错误标记，合并侧在 iframe 节点上输出
                // load-failed 状态。
                _logger.error(`failed to execute javascript on frame ${frame.frameTreeNodeId}`);
                result.frameResults[frame.frameToken] = {
                    mainResult: null,
                    frameResults: {},
                    error: String(err?.message || err)
                };
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
    /** 每个会话在 webContents 上注册的销毁兜底监听，释放会话时一并注销。 */
    private _destroyedHooks = new Map<number, { wc: Electron.WebContents; listener: () => void }>();

    /** 注销某个 webContentsId 的销毁兜底监听（会话已被释放或替换）。 */
    private _detachDestroyedHook(webContentsId: number): void {
        const hook = this._destroyedHooks.get(webContentsId);
        if (!hook) return;
        this._destroyedHooks.delete(webContentsId);
        try {
            hook.wc.removeListener('destroyed', hook.listener);
        } catch {
            // webContents 已销毁时原生属性访问可能抛出，忽略即可
        }
    }

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
            this._detachDestroyedHook(webContentsId);
        }

        // Resolve webContents from ID
        const { webContents } = await import('electron');
        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed()) {
            throw new Error(`WebContents ${webContentsId} not found or destroyed`);
        }

        const session = await CDPSession.create(wc);
        // 兜底清理：webContents 销毁（webview 移除、任务删除、窗口关闭、renderer
        // 重载）时立即释放对应 CDP 会话并移出缓存。否则持有已销毁 webContents
        // 引用与 debugger listener 的会话会永久留在 Map 中，随任务反复
        // 创建/销毁而单调增长。
        // 监听器按会话记录、释放时注销：不健康重建会为同一个 webContents 反复
        // 注册，只 once 不 remove 的话，旧闭包（连同旧 session）会一直挂到
        // webContents 销毁。
        const listener = () => {
            session.dispose();
            // 身份校验：同一 webContents 上可能已注册过别的会话的监听，只清自己的记账
            if (this._destroyedHooks.get(webContentsId)?.listener === listener) {
                this._destroyedHooks.delete(webContentsId);
            }
            // 身份校验：session 被替换（不健康重建）后，旧监听器不得驱逐新 session
            if (this._sessions.get(webContentsId) === session) {
                this._sessions.delete(webContentsId);
            }
        };
        wc.once('destroyed', listener);
        this._destroyedHooks.set(webContentsId, { wc, listener });
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
        this._detachDestroyedHook(webContentsId);
    }

    /**
     * Dispose all sessions.
     */
    disposeAll(): void {
        for (const [, session] of this._sessions) {
            session.dispose();
        }
        this._sessions.clear();
        for (const webContentsId of Array.from(this._destroyedHooks.keys())) {
            this._detachDestroyedHook(webContentsId);
        }
    }
}
