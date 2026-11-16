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
 * Web 模式 IPC 桥：让浏览器连接成为 ipcMain 处理器眼中的一个"renderer"。
 *
 * - installIpcRecorder 在任何处理器注册前接管 ipcMain.handle 系列，记下 channel → handler，
 *   原注册照常进行（桌面行为不变）。
 * - 每条 WebSocket 连接对应一个 WebIpcClient，扮演 event.sender / event.senderFrame：
 *   处理器对它的 send() 会推回该浏览器；按 senderFrame 订阅的任务流因此天然按连接隔离。
 * - 处理器向真实窗口（隐藏主窗口）发送的消息广播给所有连接。
 * - 原生对话框 / shell 在 web 模式下转交给触发当前 IPC 的浏览器（AsyncLocalStorage 追踪），
 *   没有上下文时交给最近活跃的连接。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { encodeIpcValue } from '../../common/web/ipc-codec.js';
import { WEB_FS_PATH, type ServerMessage, type WebRequestKind } from '../../common/web/protocol.js';
import { logger } from '../utils/logger.js';

type InvokeHandler = Parameters<typeof ipcMain.handle>[1];

const invokeHandlers = new Map<string, InvokeHandler>();
const handlerWaiters = new Map<string, Set<() => void>>();
const clients = new Set<WebIpcClient>();
const clientContext = new AsyncLocalStorage<WebIpcClient>();
let lastActiveClient: WebIpcClient | null = null;

/** 处理器在 createWindow 之后才陆续注册；浏览器早于注册到达时最多等待这么久 */
const HANDLER_WAIT_MS = 30_000;

// 与真实 webContents id 错开，避免与窗口 id 比较时误判为同一个 renderer
let nextClientId = 1_000_000;

class WebFrame {
    readonly routingId = 1;
    readonly processId = 0;
    readonly frameTreeNodeId: number;
    readonly parent = null;
    readonly frames: WebFrame[] = [];

    constructor(private readonly client: WebIpcClient) {
        this.frameTreeNodeId = client.id;
    }

    get top(): WebFrame {
        return this;
    }

    get url(): string {
        return this.client.getURL();
    }

    get origin(): string {
        try {
            return new URL(this.client.getURL()).origin;
        } catch {
            return '';
        }
    }

    isDestroyed(): boolean {
        return this.client.isDestroyed();
    }

    send(channel: string, ...args: unknown[]): void {
        this.client.send(channel, ...args);
    }
}

/** 一个浏览器页面（WebSocket 连接），对 ipcMain 处理器表现为 WebContents + 主 frame */
export class WebIpcClient extends EventEmitter {
    readonly id = nextClientId++;
    readonly mainFrame: WebFrame;
    readonly hostWebContents = null;
    private destroyed = false;
    private nextRequestId = 1;
    private readonly pendingRequests = new Map<number, (value: unknown) => void>();

    constructor(
        private readonly transmit: (message: ServerMessage) => void,
        private readonly pageUrl: string
    ) {
        super();
        this.setMaxListeners(0);
        this.mainFrame = new WebFrame(this);
        clients.add(this);
    }

    getURL(): string {
        return this.pageUrl;
    }

    getTitle(): string {
        return 'OpenDesk';
    }

    getType(): string {
        return 'window';
    }

    getOwnerBrowserWindow(): null {
        // window:close 等窗口控制在 web 模式下由浏览器侧直接处理
        return null;
    }

    getOSProcessId(): number {
        return 0;
    }

    getProcessId(): number {
        return 0;
    }

    isLoading(): boolean {
        return false;
    }

    isCrashed(): boolean {
        return false;
    }

    isDestroyed(): boolean {
        return this.destroyed;
    }

    send(channel: string, ...args: unknown[]): void {
        if (this.destroyed) return;
        this.post({ t: 'evt', ch: channel, a: encodeIpcValue(args) });
    }

    post(message: ServerMessage): void {
        if (this.destroyed) return;
        this.transmit(message);
    }

    /** 请求浏览器完成一次交互（对话框等）；连接断开时以 undefined 结束 */
    request(kind: WebRequestKind, payload: unknown): Promise<unknown> {
        if (this.destroyed) return Promise.resolve(undefined);
        const id = this.nextRequestId++;
        return new Promise((resolve) => {
            this.pendingRequests.set(id, resolve);
            this.post({ t: 'req', id, kind, p: encodeIpcValue(payload) });
        });
    }

    resolveRequest(id: number, value: unknown): void {
        const resolve = this.pendingRequests.get(id);
        if (!resolve) return;
        this.pendingRequests.delete(id);
        resolve(value);
    }

    markActive(): void {
        setLastActiveClient(this);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        clients.delete(this);
        if (lastActiveClient === this) lastActiveClient = [...clients].pop() ?? null;
        for (const resolve of this.pendingRequests.values()) resolve(undefined);
        this.pendingRequests.clear();
        this.emit('destroyed');
        this.removeAllListeners();
    }
}

function setLastActiveClient(client: WebIpcClient): void {
    lastActiveClient = client;
}

function notifyHandlerRegistered(channel: string): void {
    const waiters = handlerWaiters.get(channel);
    if (!waiters) return;
    handlerWaiters.delete(channel);
    for (const wake of waiters) wake();
}

/**
 * 接管 ipcMain.handle / handleOnce / removeHandler，记录处理器。
 * 必须在 main.js 及其依赖求值之前调用（见 startup/bootstrap.ts）。
 */
export function installIpcRecorder(): void {
    const originalHandle = ipcMain.handle.bind(ipcMain);
    const originalHandleOnce = ipcMain.handleOnce.bind(ipcMain);
    const originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain);

    ipcMain.handle = (channel: string, listener: InvokeHandler) => {
        originalHandle(channel, listener);
        invokeHandlers.set(channel, listener);
        notifyHandlerRegistered(channel);
    };
    ipcMain.handleOnce = (channel: string, listener: InvokeHandler) => {
        originalHandleOnce(channel, listener);
        invokeHandlers.set(channel, (event, ...args) => {
            invokeHandlers.delete(channel);
            return listener(event, ...args);
        });
        notifyHandlerRegistered(channel);
    };
    ipcMain.removeHandler = (channel: string) => {
        originalRemoveHandler(channel);
        invokeHandlers.delete(channel);
    };

    patchNativeUi();
}

function waitForHandler(channel: string): Promise<InvokeHandler | undefined> {
    const existing = invokeHandlers.get(channel);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
        const wake = () => {
            clearTimeout(timer);
            resolve(invokeHandlers.get(channel));
        };
        const timer = setTimeout(() => {
            handlerWaiters.get(channel)?.delete(wake);
            resolve(undefined);
        }, HANDLER_WAIT_MS);
        let waiters = handlerWaiters.get(channel);
        if (!waiters) {
            waiters = new Set();
            handlerWaiters.set(channel, waiters);
        }
        waiters.add(wake);
    });
}

function createEvent(client: WebIpcClient) {
    return {
        sender: client,
        senderFrame: client.mainFrame,
        frameId: client.mainFrame.routingId,
        processId: 0,
        type: 'frame' as const,
        defaultPrevented: false,
        preventDefault() {
            this.defaultPrevented = true;
        }
    };
}

/** ipcRenderer.invoke → ipcMain.handle */
export async function dispatchInvoke(client: WebIpcClient, channel: string, args: unknown[]): Promise<unknown> {
    const handler = await waitForHandler(channel);
    if (!handler) throw new Error(`No handler registered for '${channel}'`);
    // WebIpcClient 只实现了处理器实际用到的 WebContents/WebFrameMain 子集
    return clientContext.run(client, () => handler(createEvent(client) as never, ...args));
}

/** ipcRenderer.send → ipcMain.on */
export function dispatchSend(client: WebIpcClient, channel: string, args: unknown[]): void {
    const event = {
        ...createEvent(client),
        returnValue: undefined as unknown,
        ports: [],
        reply: (replyChannel: string, ...replyArgs: unknown[]) => client.send(replyChannel, ...replyArgs)
    };
    clientContext.run(client, () => {
        try {
            ipcMain.emit(channel, event, ...args);
        } catch (error) {
            logger.error(`[web] ipcMain listener for "${channel}" threw: ${(error as Error)?.stack || error}`);
        }
    });
}

export function broadcast(channel: string, args: unknown[]): void {
    for (const client of clients) client.send(channel, ...args);
}

export function broadcastMessage(message: ServerMessage): void {
    for (const client of clients) client.post(message);
}

/**
 * 隐藏主窗口不加载 renderer；main 侧发往它的消息（BrowserWindow 广播、
 * globalMainWindow.webContents.send 等）转发给所有浏览器连接。
 */
export function attachHiddenMainWindow(win: BrowserWindow): void {
    const contents = win.webContents;
    contents.send = (channel: string, ...args: unknown[]) => broadcast(channel, args);
    const frame = contents.mainFrame;
    if (frame) frame.send = (channel: string, ...args: unknown[]) => broadcast(channel, args);
}

function interactionClient(): WebIpcClient | null {
    const current = clientContext.getStore();
    if (current && !current.isDestroyed()) return current;
    return lastActiveClient && !lastActiveClient.isDestroyed() ? lastActiveClient : null;
}

export function webFileUrl(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return `${WEB_FS_PATH}${absolute.split('/').map(encodeURIComponent).join('/')}`;
}

/** dialog.* 第一个参数可以是 BrowserWindow，统一取出 options */
function dialogOptions(args: unknown[]): Record<string, unknown> {
    const last = args[args.length - 1];
    return last && typeof last === 'object' && !(last instanceof BrowserWindow)
        ? (last as Record<string, unknown>)
        : {};
}

/**
 * 容器里没有可交互的桌面：原生对话框与 shell 转交浏览器完成。
 * 同步版本（*Sync）无法等待浏览器，按"用户取消"处理。
 */
function patchNativeUi(): void {
    const d = dialog as unknown as Record<string, unknown>;

    d.showOpenDialog = async (...args: unknown[]) => {
        const options = dialogOptions(args);
        const client = interactionClient();
        const result = client ? ((await client.request('openDialog', options)) as string[] | undefined) : undefined;
        return result && result.length > 0 ? { canceled: false, filePaths: result } : { canceled: true, filePaths: [] };
    };
    d.showSaveDialog = async (...args: unknown[]) => {
        const options = dialogOptions(args);
        const client = interactionClient();
        const result = client ? ((await client.request('saveDialog', options)) as string | undefined) : undefined;
        return result ? { canceled: false, filePath: result } : { canceled: true, filePath: '' };
    };
    d.showMessageBox = async (...args: unknown[]) => {
        const options = dialogOptions(args);
        const client = interactionClient();
        const result = client
            ? ((await client.request('messageBox', options)) as
                  { response: number; checkboxChecked: boolean } | undefined)
            : undefined;
        const cancelId = typeof options.cancelId === 'number' ? options.cancelId : 0;
        return result ?? { response: cancelId, checkboxChecked: false };
    };
    d.showOpenDialogSync = () => undefined;
    d.showSaveDialogSync = () => undefined;
    d.showMessageBoxSync = (...args: unknown[]) => {
        const options = dialogOptions(args);
        return typeof options.cancelId === 'number' ? options.cancelId : 0;
    };
    d.showErrorBox = (title: string, content: string) => {
        logger.error(`[web] ${title}: ${content}`);
        broadcastMessage({ t: 'alert', title, message: content });
    };

    const s = shell as unknown as Record<string, unknown>;
    s.openPath = async (filePath: string) => {
        const client = interactionClient();
        if (!client) return 'no web client connected';
        client.post({ t: 'open', url: webFileUrl(filePath) });
        return '';
    };
    s.openExternal = async (url: string) => {
        // 某个标签页的 IPC 调用触发的，就在它那里打开；插件或 worker 在后台发起的
        // （如 SSO 授权）无法确定由谁触发，发给所有连接，保证用户能看到
        const current = clientContext.getStore();
        if (current && !current.isDestroyed()) current.post({ t: 'open', url });
        else broadcastMessage({ t: 'open', url });
    };
    s.showItemInFolder = (filePath: string) => {
        interactionClient()?.post({ t: 'open', url: webFileUrl(path.dirname(filePath)) });
    };
}
